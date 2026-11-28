import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { NextRequest, NextResponse } from "next/server";
import { loadServerFaucetKeypair } from "@/lib/faucet-key";
import {
  acquireAtomicLock,
  decrementWindowCounter,
   getAtomicStoreMode,
  incrementWindowCounter,
  peekKeyTtlSeconds,
  releaseAtomicKey,
} from "@/lib/kv-store";
import { DEFAULT_DEVNET_RPC } from "@/lib/leash-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const FAUCET_DRIP_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL); // 0.05 SOL
const MIN_FAUCET_RESERVE_LAMPORTS = Math.floor(0.06 * LAMPORTS_PER_SOL); // 0.06 SOL minimum reserve
const SKIP_THRESHOLD_LAMPORTS = Math.floor(0.08 * LAMPORTS_PER_SOL); // >= 0.08 SOL skip
const PUBKEY_COOLDOWN_SECONDS = 5 * 60; // 5 minutes per-pubkey cooldown
const IP_WINDOW_SECONDS = 10 * 60; // 10 minutes per-IP window
const IP_MAX_DRIPS_PER_WINDOW = 5; // max 5 drips per 10 minutes per IP
const RPC_CALL_TIMEOUT_MS = 15_000;
const CONFIRM_TIMEOUT_MS = 40_000;
const FALLBACK_FAUCET_URL = "https://faucet.solana.com";

class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTimeoutError";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new RpcTimeoutError(timeoutMessage)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "local-ip";
}

export async function POST(request: NextRequest) {
  try {
    let faucetKeypair;
    try {
      faucetKeypair = loadServerFaucetKeypair();
    } catch (err: unknown) {
      return NextResponse.json(
        {
          configured: false,
          funded: false,
          error:
            err instanceof Error
              ? err.message
              : "Malformed server FAUCET_SECRET_KEY.",
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 503 }
      );
    }

    if (!faucetKeypair) {
      return NextResponse.json(
        {
          configured: false,
          funded: false,
          error: "Server-side Devnet faucet is not configured.",
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 503 }
      );
    }

    let body: { pubkey?: unknown };
    try {
      body = (await request.json()) as { pubkey?: unknown };
    } catch {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: "Invalid JSON request body.",
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 400 }
      );
    }

    if (typeof body.pubkey !== "string" || !body.pubkey.trim()) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: "Missing recipient pubkey.",
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 400 }
      );
    }

    let recipient: PublicKey;
    try {
      recipient = new PublicKey(body.pubkey.trim());
    } catch {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: "Invalid Solana public key.",
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 400 }
      );
    }

    if (recipient.equals(faucetKeypair.publicKey)) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: "Cannot request drip to faucet wallet itself.",
        },
        { status: 400 }
      );
    }

    const clientIp = extractClientIp(request);
    const recipientStr = recipient.toBase58();
    const ipKey = `leash:faucet:ipwin:${clientIp}`;
    const pkKey = `leash:faucet:pk:${recipientStr}`;
    const storeMode = getAtomicStoreMode();

    // Fast pre-RPC check for per-pubkey 5-minute cooldown
    const pkCheck = await peekKeyTtlSeconds(pkKey);
    if (pkCheck.exists) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: `Wallet cooldown active. Retry in ${pkCheck.ttlSeconds}s.`,
          retryAfterSeconds: pkCheck.ttlSeconds,
          storeMode: pkCheck.storeMode,
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 429 }
      );
    }

    const rpcUrl =
      process.env.SOLANA_RPC_URL?.trim() ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
      DEFAULT_DEVNET_RPC;
    const connection = new Connection(rpcUrl, "confirmed");

    // Batch balance check into a single confirmed RPC call with timeout
    const accounts = await withTimeout(
      connection.getMultipleAccountsInfo(
        [recipient, faucetKeypair.publicKey],
        "confirmed"
      ),
      RPC_CALL_TIMEOUT_MS,
      "Solana Devnet RPC timed out while checking balances."
    );

    const recipientLamports = accounts[0]?.lamports ?? 0;
    const faucetLamports = accounts[1]?.lamports ?? 0;

    if (recipientLamports >= SKIP_THRESHOLD_LAMPORTS) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          skipped: true,
          reason: "Wallet already holds >= 0.08 Devnet SOL.",
          balanceSol: recipientLamports / LAMPORTS_PER_SOL,
          storeMode,
        },
        { status: 200 }
      );
    }

    if (faucetLamports < MIN_FAUCET_RESERVE_LAMPORTS) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: `Server faucet balance (${(
            faucetLamports / LAMPORTS_PER_SOL
          ).toFixed(4)} SOL) is below the 0.06 SOL safety threshold.`,
          balanceSol: Number((faucetLamports / LAMPORTS_PER_SOL).toFixed(4)),
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 503 }
      );
    }

    // 1. Acquire 5-minute per-pubkey atomic lock
    const pkAcquired = await acquireAtomicLock(pkKey, PUBKEY_COOLDOWN_SECONDS);
    if (!pkAcquired) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: "Concurrent wallet cooldown active (1 drip per 5 minutes).",
          retryAfterSeconds: PUBKEY_COOLDOWN_SECONDS,
          storeMode,
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 429 }
      );
    }

    // 2. Increment 10-minute per-IP window counter (allows up to 5 drips / 10 min per IP)
    let ipCount = 0;
    try {
      ipCount = await incrementWindowCounter(ipKey, IP_WINDOW_SECONDS);
    } catch (kvErr: unknown) {
      await releaseAtomicKey(pkKey);
      throw kvErr;
    }

    if (ipCount > IP_MAX_DRIPS_PER_WINDOW) {
      await releaseAtomicKey(pkKey);
      const ipTtl = await peekKeyTtlSeconds(ipKey).catch(() => ({
        ttlSeconds: IP_WINDOW_SECONDS,
      }));
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: `IP rate limit reached (${IP_MAX_DRIPS_PER_WINDOW} drips per 10 minutes). Retry in ${ipTtl.ttlSeconds}s.`,
          retryAfterSeconds: ipTtl.ttlSeconds,
          storeMode,
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 429 }
      );
    }

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: faucetKeypair.publicKey,
          toPubkey: recipient,
          lamports: FAUCET_DRIP_LAMPORTS,
        })
      );
      tx.feePayer = faucetKeypair.publicKey;
      const latest = await withTimeout(
        connection.getLatestBlockhash("confirmed"),
        RPC_CALL_TIMEOUT_MS,
        "Solana Devnet RPC timed out fetching latest blockhash."
      );
      tx.recentBlockhash = latest.blockhash;
      tx.sign(faucetKeypair);

      const txSignature = await withTimeout(
        connection.sendRawTransaction(tx.serialize(), {
          maxRetries: 5,
          preflightCommitment: "confirmed",
        }),
        RPC_CALL_TIMEOUT_MS,
        "Solana Devnet RPC timed out broadcasting faucet transaction."
      );

      const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
      let confirmed = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 900));
        const statuses = await withTimeout(
          connection.getSignatureStatuses([txSignature]),
          RPC_CALL_TIMEOUT_MS,
          "Solana Devnet RPC timed out polling transaction signature status."
        );
        const st = statuses.value[0];
        if (
          st &&
          (st.confirmationStatus === "confirmed" ||
            st.confirmationStatus === "finalized")
        ) {
          if (st.err) {
            throw new Error(`Faucet tx reverted: ${JSON.stringify(st.err)}`);
          }
          confirmed = true;
          break;
        }
      }

      if (!confirmed) {
        throw new RpcTimeoutError(
          `Timed out waiting for confirmed status on faucet transfer ${txSignature}`
        );
      }

      return NextResponse.json(
        {
          configured: true,
          funded: true,
          amountSol: FAUCET_DRIP_LAMPORTS / LAMPORTS_PER_SOL,
          txSignature,
          recipient: recipientStr,
          ipDripsUsedInWindow: ipCount,
          ipDripsMaxInWindow: IP_MAX_DRIPS_PER_WINDOW,
          storeMode,
        },
        { status: 200 }
      );
    } catch (sendErr: unknown) {
      await Promise.all([
        releaseAtomicKey(pkKey),
        decrementWindowCounter(ipKey),
      ]);
      throw sendErr;
    }
  } catch (err: unknown) {
    const isTimeout = err instanceof RpcTimeoutError;
    return NextResponse.json(
      {
        configured: true,
        funded: false,
        error: err instanceof Error ? err.message : String(err),
        fallbackUrl: FALLBACK_FAUCET_URL,
      },
      { status: isTimeout ? 504 : 502 }
    );
  }
}

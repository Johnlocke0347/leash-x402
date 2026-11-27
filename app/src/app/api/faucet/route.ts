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
  claimAtomicKey,
  peekKeyTtlSeconds,
  releaseAtomicKey,
} from "@/lib/kv-store";
import { DEFAULT_DEVNET_RPC } from "@/lib/leash-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FAUCET_DRIP_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL); // 0.05 SOL
const SKIP_THRESHOLD_LAMPORTS = Math.floor(0.08 * LAMPORTS_PER_SOL); // 0.08 SOL
const COOLDOWN_SECONDS = 5 * 60; // 5 minutes
const FALLBACK_FAUCET_URL = "https://faucet.solana.com";

function extractClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "local-ip";
}

export async function POST(request: NextRequest) {
  let faucetKeypair;
  try {
    faucetKeypair = loadServerFaucetKeypair();
  } catch (err: unknown) {
    return NextResponse.json(
      {
        configured: false,
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
      { error: "Invalid JSON request body.", fallbackUrl: FALLBACK_FAUCET_URL },
      { status: 400 }
    );
  }

  if (typeof body.pubkey !== "string" || !body.pubkey.trim()) {
    return NextResponse.json(
      { error: "Missing recipient pubkey.", fallbackUrl: FALLBACK_FAUCET_URL },
      { status: 400 }
    );
  }

  let recipient: PublicKey;
  try {
    recipient = new PublicKey(body.pubkey.trim());
  } catch {
    return NextResponse.json(
      { error: "Invalid Solana public key.", fallbackUrl: FALLBACK_FAUCET_URL },
      { status: 400 }
    );
  }

  if (recipient.equals(faucetKeypair.publicKey)) {
    return NextResponse.json(
      { error: "Cannot request drip to faucet wallet itself." },
      { status: 400 }
    );
  }

  const clientIp = extractClientIp(request);
  const recipientStr = recipient.toBase58();
  const ipKey = `leash:faucet:ip:${clientIp}`;
  const pkKey = `leash:faucet:pk:${recipientStr}`;

  const [ipCheck, pkCheck] = await Promise.all([
    peekKeyTtlSeconds(ipKey),
    peekKeyTtlSeconds(pkKey),
  ]);

  if (ipCheck.exists) {
    return NextResponse.json(
      {
        configured: true,
        error: `IP cooldown active. Retry in ${ipCheck.ttlSeconds}s.`,
        retryAfterSeconds: ipCheck.ttlSeconds,
        storeMode: ipCheck.storeMode,
        fallbackUrl: FALLBACK_FAUCET_URL,
      },
      { status: 429 }
    );
  }

  if (pkCheck.exists) {
    return NextResponse.json(
      {
        configured: true,
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

  try {
    const [recipientLamports, faucetLamports] = await Promise.all([
      connection.getBalance(recipient, "confirmed"),
      connection.getBalance(faucetKeypair.publicKey, "confirmed"),
    ]);

    if (recipientLamports >= SKIP_THRESHOLD_LAMPORTS) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          skipped: true,
          reason: "Wallet already holds >= 0.08 Devnet SOL.",
          balanceSol: recipientLamports / LAMPORTS_PER_SOL,
        },
        { status: 200 }
      );
    }

    if (faucetLamports < FAUCET_DRIP_LAMPORTS + 10_000) {
      return NextResponse.json(
        {
          configured: true,
          funded: false,
          error: "Server faucet reserve is temporarily depleted.",
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 503 }
      );
    }

    // Atomically lock IP and pubkey cooldown keys before sending SOL
    const ipLock = await claimAtomicKey(ipKey, COOLDOWN_SECONDS);
    if (!ipLock.acquired) {
      return NextResponse.json(
        {
          configured: true,
          error: "Concurrent faucet cooldown active.",
          retryAfterSeconds: COOLDOWN_SECONDS,
          storeMode: ipLock.storeMode,
          fallbackUrl: FALLBACK_FAUCET_URL,
        },
        { status: 429 }
      );
    }

    const pkLock = await claimAtomicKey(pkKey, COOLDOWN_SECONDS);
    if (!pkLock.acquired) {
      await releaseAtomicKey(ipKey);
      return NextResponse.json(
        {
          configured: true,
          error: "Concurrent wallet cooldown active.",
          retryAfterSeconds: COOLDOWN_SECONDS,
          storeMode: pkLock.storeMode,
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
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      tx.sign(faucetKeypair);

      const txSignature = await connection.sendRawTransaction(tx.serialize(), {
        maxRetries: 5,
      });

      const deadline = Date.now() + 45_000;
      let confirmed = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200));
        const statuses = await connection.getSignatureStatuses([txSignature]);
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
        throw new Error(`Timed out confirming faucet transfer ${txSignature}`);
      }

      return NextResponse.json(
        {
          configured: true,
          funded: true,
          amountSol: FAUCET_DRIP_LAMPORTS / LAMPORTS_PER_SOL,
          txSignature,
          recipient: recipientStr,
          storeMode: pkLock.storeMode,
        },
        { status: 200 }
      );
    } catch (sendErr: unknown) {
      await Promise.all([releaseAtomicKey(ipKey), releaseAtomicKey(pkKey)]);
      throw sendErr;
    }
  } catch (err: unknown) {
    return NextResponse.json(
      {
        configured: true,
        funded: false,
        error: err instanceof Error ? err.message : String(err),
        fallbackUrl: FALLBACK_FAUCET_URL,
      },
      { status: 502 }
    );
  }
}

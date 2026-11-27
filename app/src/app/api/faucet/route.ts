import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_DEVNET_RPC } from "@/lib/leash-protocol";

export const dynamic = "force-dynamic";

const FAUCET_DRIP_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL); // 0.05 SOL
const SKIP_THRESHOLD_LAMPORTS = Math.floor(0.08 * LAMPORTS_PER_SOL); // 0.08 SOL
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const FALLBACK_FAUCET_URL = "https://faucet.solana.com";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// NOTE: In-memory per-IP & per-pubkey cooldown maps for single-instance / demo servers.
// Multi-instance serverless deployments should store rate-limit keys in Redis / Vercel KV.
const globalForFaucet = globalThis as unknown as {
  __leashFaucetIpCooldowns?: Map<string, number>;
  __leashFaucetPubkeyCooldowns?: Map<string, number>;
};
const ipCooldowns =
  globalForFaucet.__leashFaucetIpCooldowns ?? new Map<string, number>();
const pubkeyCooldowns =
  globalForFaucet.__leashFaucetPubkeyCooldowns ?? new Map<string, number>();
globalForFaucet.__leashFaucetIpCooldowns = ipCooldowns;
globalForFaucet.__leashFaucetPubkeyCooldowns = pubkeyCooldowns;

function pruneCooldowns(map: Map<string, number>, nowMs: number): void {
  for (const [key, expiresAt] of map.entries()) {
    if (expiresAt <= nowMs) {
      map.delete(key);
    }
  }
}

function decodeBase58(input: string): Uint8Array {
  let num = 0n;
  for (let i = 0; i < input.length; i++) {
    const charIdx = BASE58_ALPHABET.indexOf(input[i]);
    if (charIdx < 0) {
      throw new Error("Invalid base58 character in FAUCET_SECRET_KEY");
    }
    num = num * 58n + BigInt(charIdx);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();

  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === "1") {
    leadingZeros++;
  }

  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

function parseFaucetKeypair(rawSecret: string): Keypair {
  const trimmed = rawSecret.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => typeof n === "number" && n >= 0 && n <= 255)
    ) {
      throw new Error("FAUCET_SECRET_KEY JSON array must contain 64 bytes");
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  const decoded = decodeBase58(trimmed);
  return Keypair.fromSecretKey(decoded);
}

function extractClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown-ip";
}

export async function POST(request: NextRequest) {
  const rawSecret = process.env.FAUCET_SECRET_KEY?.trim();
  if (!rawSecret) {
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

  let faucetKeypair: Keypair;
  try {
    faucetKeypair = parseFaucetKeypair(rawSecret);
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

  if (recipient.equals(faucetKeypair.publicKey)) {
    return NextResponse.json(
      { error: "Cannot request drip to faucet wallet itself." },
      { status: 400 }
    );
  }

  const nowMs = Date.now();
  pruneCooldowns(ipCooldowns, nowMs);
  pruneCooldowns(pubkeyCooldowns, nowMs);

  const clientIp = extractClientIp(request);
  const recipientStr = recipient.toBase58();

  const ipUntil = ipCooldowns.get(clientIp);
  if (ipUntil && ipUntil > nowMs) {
    return NextResponse.json(
      {
        configured: true,
        error: `IP cooldown active. Retry in ${Math.ceil((ipUntil - nowMs) / 1000)}s.`,
        retryAfterSeconds: Math.ceil((ipUntil - nowMs) / 1000),
        fallbackUrl: FALLBACK_FAUCET_URL,
      },
      { status: 429 }
    );
  }

  const pubkeyUntil = pubkeyCooldowns.get(recipientStr);
  if (pubkeyUntil && pubkeyUntil > nowMs) {
    return NextResponse.json(
      {
        configured: true,
        error: `Wallet cooldown active. Retry in ${Math.ceil((pubkeyUntil - nowMs) / 1000)}s.`,
        retryAfterSeconds: Math.ceil((pubkeyUntil - nowMs) / 1000),
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

    const expiresAt = Date.now() + COOLDOWN_MS;
    ipCooldowns.set(clientIp, expiresAt);
    pubkeyCooldowns.set(recipientStr, expiresAt);

    return NextResponse.json(
      {
        configured: true,
        funded: true,
        amountSol: FAUCET_DRIP_LAMPORTS / LAMPORTS_PER_SOL,
        txSignature,
        recipient: recipientStr,
      },
      { status: 200 }
    );
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

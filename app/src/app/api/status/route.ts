import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { loadServerFaucetKeypair } from "@/lib/faucet-key";
import { getAtomicStoreMode } from "@/lib/kv-store";
import {
  DEFAULT_DEVNET_RPC,
  DEVNET_USDC_MINT,
  LEASH_PROGRAM_ID,
} from "@/lib/leash-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const PUBLIC_DEVNET_ENDPOINT = "https://api.devnet.solana.com";
const STATUS_RPC_TIMEOUT_MS = 10_000;

export async function GET() {
  const rpcUrl =
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    DEFAULT_DEVNET_RPC;

  const normalizedRpc = rpcUrl.replace(/\/+$/, "");
  const rpcMode =
    normalizedRpc === PUBLIC_DEVNET_ENDPOINT ? "public_devnet" : "custom_rpc";

  const allowSandboxMockMint = process.env.ALLOW_SANDBOX_MOCK_MINT === "true";
  let expectedMintStr = DEVNET_USDC_MINT.toBase58();
  try {
    if (process.env.EXPECTED_MINT?.trim()) {
      expectedMintStr = new PublicKey(
        process.env.EXPECTED_MINT.trim()
      ).toBase58();
    }
  } catch {
    expectedMintStr = DEVNET_USDC_MINT.toBase58();
  }

  let faucetDiagnostics: {
    configured: boolean;
    pubkey?: string;
    balanceSol?: number;
  } = { configured: false };

  try {
    const faucetKp = loadServerFaucetKeypair();
    if (faucetKp) {
      const connection = new Connection(rpcUrl, "confirmed");
      const lamports = await Promise.race([
        connection.getBalance(faucetKp.publicKey, "confirmed"),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), STATUS_RPC_TIMEOUT_MS)
        ),
      ]).catch(() => null);
      faucetDiagnostics = {
        configured: true,
        pubkey: faucetKp.publicKey.toBase58(),
        ...(lamports !== null
          ? { balanceSol: Number((lamports / LAMPORTS_PER_SOL).toFixed(4)) }
          : {}),
      };
    }
  } catch {
    faucetDiagnostics = { configured: false };
  }

  return NextResponse.json(
    {
      programId: LEASH_PROGRAM_ID.toBase58(),
      cluster: "devnet",
      rpcMode,
      faucet: faucetDiagnostics,
      replayStore: getAtomicStoreMode(),
      mintPolicy: {
        mode: allowSandboxMockMint ? "sandbox_mock_mint" : "strict_usdc",
        expectedMint: expectedMintStr,
      },
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

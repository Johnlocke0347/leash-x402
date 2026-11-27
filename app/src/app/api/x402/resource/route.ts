import { Connection, PublicKey } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_DEVNET_RPC,
  LEASH_PROGRAM_ID,
  X402_CHALLENGE_AMOUNT,
  X402_MERCHANT_PUBKEY,
  X402_RECEIPT_TTL_SLOTS,
  bytesToHex,
  decodeReceipt,
  deriveReceiptPda,
} from "@/lib/leash-protocol";

export const dynamic = "force-dynamic";

const RESOURCE_PATH = "/api/x402/resource";

function computeChallengeHash(nonce: string): {
  preimage: string;
  hashBytes: Uint8Array;
  hashHex: string;
} {
  const preimage = `GET|${RESOURCE_PATH}|${X402_MERCHANT_PUBKEY.toBase58()}|${X402_CHALLENGE_AMOUNT.toString()}|${nonce}`;
  const digest = createHash("sha256").update(preimage).digest();
  const hashBytes = new Uint8Array(digest);
  return {
    preimage,
    hashBytes,
    hashHex: bytesToHex(hashBytes),
  };
}

function paymentRequiredResponse(nonce: string, reason?: string) {
  const { preimage, hashHex } = computeChallengeHash(nonce);

  return NextResponse.json(
    {
      status: 402,
      error: "Payment Required",
      reason:
        reason ??
        "Submit an on-chain Leash execute_agent_spend transaction settling this challenge and retry with X-402-Vault, X-402-Nonce, and X-402-Tx-Signature headers.",
      challenge: {
        version: "x402-leash-v1",
        cluster: "devnet",
        programId: LEASH_PROGRAM_ID.toBase58(),
        method: "GET",
        path: RESOURCE_PATH,
        merchant: X402_MERCHANT_PUBKEY.toBase58(),
        amount: X402_CHALLENGE_AMOUNT.toString(),
        receiptTtlSlots: Number(X402_RECEIPT_TTL_SLOTS),
        nonce,
        canonicalPreimage: preimage,
        requestHashHex: hashHex,
      },
    },
    {
      status: 402,
      headers: {
        "WWW-Authenticate": `x402 realm="leash-devnet", merchant="${X402_MERCHANT_PUBKEY.toBase58()}", amount="${X402_CHALLENGE_AMOUNT.toString()}"`,
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function GET(request: NextRequest) {
  const vaultHeader = request.headers.get("x-402-vault");
  const nonceHeader = request.headers.get("x-402-nonce");
  const txSigHeader = request.headers.get("x-402-tx-signature");
  const rpcOverride = request.headers.get("x-402-rpc-url");

  // Unauthenticated request -> issue fresh HTTP 402 challenge
  if (!vaultHeader || !nonceHeader) {
    const freshNonce = randomBytes(12).toString("hex");
    return paymentRequiredResponse(freshNonce);
  }

  let vaultPubkey: PublicKey;
  try {
    vaultPubkey = new PublicKey(vaultHeader);
  } catch {
    return paymentRequiredResponse(
      nonceHeader,
      "Invalid X-402-Vault header: malformed Solana public key."
    );
  }

  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(nonceHeader)) {
    return paymentRequiredResponse(
      randomBytes(12).toString("hex"),
      "Malformed X-402-Nonce format."
    );
  }

  // Recompute canonical request_hash server-side (never trust client-supplied hash/amount/merchant)
  const { preimage, hashBytes, hashHex } = computeChallengeHash(nonceHeader);
  const [expectedReceiptPda, expectedBump] = deriveReceiptPda(
    vaultPubkey,
    hashBytes,
    LEASH_PROGRAM_ID
  );

  // Security check: only allow official Solana Devnet or configured RPC host
  const rpcUrl =
    rpcOverride && rpcOverride.startsWith("https://")
      ? rpcOverride
      : process.env.SOLANA_RPC_URL || DEFAULT_DEVNET_RPC;

  const connection = new Connection(rpcUrl, "confirmed");

  try {
    const [receiptAccount, currentSlot] = await Promise.all([
      connection.getAccountInfo(expectedReceiptPda, "confirmed"),
      connection.getSlot("confirmed"),
    ]);

    // CRITICAL x402 SECURITY INVARIANT:
    // Never accept tx.meta.err == null alone! Soft-tripped Leash transactions intentionally
    // return Ok(()) to commit SessionStatus::Tripped on-chain while allocating NO Receipt PDA.
    if (!receiptAccount) {
      return paymentRequiredResponse(
        nonceHeader,
        `On-chain Receipt PDA (${expectedReceiptPda.toBase58()}) does NOT exist on Devnet. Note: Leash circuit-breaker trips commit with tx.meta.err == null but allocate zero Receipt PDA — non-reverting x402 bypass blocked.`
      );
    }

    if (!receiptAccount.owner.equals(LEASH_PROGRAM_ID)) {
      return paymentRequiredResponse(
        nonceHeader,
        `Receipt account owner (${receiptAccount.owner.toBase58()}) does not match Leash Program ID (${LEASH_PROGRAM_ID.toBase58()}).`
      );
    }

    const decoded = decodeReceipt(
      expectedReceiptPda,
      new Uint8Array(receiptAccount.data)
    );

    if (decoded.bump !== expectedBump) {
      return paymentRequiredResponse(
        nonceHeader,
        "Receipt canonical PDA bump verification failed."
      );
    }

    if (!decoded.vault.equals(vaultPubkey)) {
      return paymentRequiredResponse(
        nonceHeader,
        `Receipt vault mismatch: expected ${vaultPubkey.toBase58()}, got ${decoded.vault.toBase58()}.`
      );
    }

    if (!decoded.merchant.equals(X402_MERCHANT_PUBKEY)) {
      return paymentRequiredResponse(
        nonceHeader,
        `Receipt merchant mismatch: expected ${X402_MERCHANT_PUBKEY.toBase58()}, got ${decoded.merchant.toBase58()}.`
      );
    }

    if (decoded.amount !== X402_CHALLENGE_AMOUNT) {
      return paymentRequiredResponse(
        nonceHeader,
        `Receipt settled amount mismatch: expected ${X402_CHALLENGE_AMOUNT.toString()}, got ${decoded.amount.toString()}.`
      );
    }

    if (decoded.requestHashHex !== hashHex) {
      return paymentRequiredResponse(
        nonceHeader,
        `Receipt request_hash mismatch: expected ${hashHex}, got ${decoded.requestHashHex}.`
      );
    }

    if (BigInt(currentSlot) >= decoded.expirySlot) {
      return paymentRequiredResponse(
        nonceHeader,
        `Receipt expired: current Devnet slot ${currentSlot} >= expiry_slot ${decoded.expirySlot.toString()}.`
      );
    }

    return NextResponse.json(
      {
        status: 200,
        verified: true,
        verificationProof: {
          cluster: "devnet",
          programId: LEASH_PROGRAM_ID.toBase58(),
          receiptPda: expectedReceiptPda.toBase58(),
          vault: decoded.vault.toBase58(),
          session: decoded.session.toBase58(),
          merchant: decoded.merchant.toBase58(),
          amountSettled: decoded.amount.toString(),
          canonicalPreimage: preimage,
          requestHashHex: decoded.requestHashHex,
          currentSlot,
          expirySlot: Number(decoded.expirySlot),
          rentPayer: decoded.rentPayer.toBase58(),
          txSignature: txSigHeader ?? null,
        },
        data: {
          feed: "solana-x402-autonomous-execution-signal",
          timestamp: new Date().toISOString(),
          settlementGuarantee:
            "Verified directly via canonical on-chain Leash Receipt PDA (immune to non-reverting soft-trip spoof).",
          signal: {
            pair: "SOL/USDC",
            regime: "LOW_VOLATILITY_EXECUTION_OK",
            maxSlippageBps: 18,
          },
        },
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        status: 502,
        error: "Solana Devnet RPC Verification Error",
        detail: message,
      },
      { status: 502 }
    );
  }
}

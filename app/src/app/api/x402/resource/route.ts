import { Connection, PublicKey } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getAtomicStoreMode,
  peekKeyTtlSeconds,
  redeemReceiptAtomically,
} from "@/lib/kv-store";
import {
  DEFAULT_DEVNET_RPC,
  DEVNET_USDC_MINT,
  LEASH_PROGRAM_ID,
  X402_CHALLENGE_AMOUNT,
  X402_MERCHANT_PUBKEY,
  X402_RECEIPT_TTL_SLOTS,
  bytesToHex,
  decodeReceipt,
  decodeVault,
  deriveReceiptPda,
  deriveVaultPda,
  formatX402CanonicalPreimage,
} from "@/lib/leash-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const RESOURCE_PATH = "/api/x402/resource";
const REDEEMED_RECEIPT_TTL_SECONDS = 30 * 60; // 30 minutes (> 300-slot Receipt TTL)

export type MintVerificationMode = "strict_expected_mint" | "sandbox_mock_mint";

function getConfiguredExpectedMint(): PublicKey {
  const raw = process.env.EXPECTED_MINT?.trim();
  if (!raw) return DEVNET_USDC_MINT;
  return new PublicKey(raw);
}

function computeChallengeHash(
  mint: PublicKey,
  nonce: string
): {
  preimage: string;
  hashBytes: Uint8Array;
  hashHex: string;
} {
  const preimage = formatX402CanonicalPreimage({
    method: "GET",
    path: RESOURCE_PATH,
    merchant: X402_MERCHANT_PUBKEY.toBase58(),
    mint: mint.toBase58(),
    amount: X402_CHALLENGE_AMOUNT.toString(),
    nonce,
  });
  const digest = createHash("sha256").update(preimage).digest();
  const hashBytes = new Uint8Array(digest);
  return {
    preimage,
    hashBytes,
    hashHex: bytesToHex(hashBytes),
  };
}

function paymentRequiredResponse(params: {
  mint: PublicKey;
  mintVerificationMode: MintVerificationMode;
  nonce: string;
  reason?: string;
}) {
  const { preimage, hashHex } = computeChallengeHash(params.mint, params.nonce);

  return NextResponse.json(
    {
      status: 402,
      error: "Payment Required",
      reason:
        params.reason ??
        "Submit an on-chain Leash execute_agent_spend transaction settling this challenge and retry with X-402-Vault, X-402-Mint, X-402-Nonce, and X-402-Tx-Signature headers.",
      replayStore: getAtomicStoreMode(),
      challenge: {
        version: "x402-leash-v2",
        cluster: "devnet",
        programId: LEASH_PROGRAM_ID.toBase58(),
        method: "GET",
        path: RESOURCE_PATH,
        merchant: X402_MERCHANT_PUBKEY.toBase58(),
        mint: params.mint.toBase58(),
        mintVerificationMode: params.mintVerificationMode,
        amount: X402_CHALLENGE_AMOUNT.toString(),
        receiptTtlSlots: Number(X402_RECEIPT_TTL_SLOTS),
        nonce: params.nonce,
        canonicalPreimage: preimage,
        requestHashHex: hashHex,
      },
    },
    {
      status: 402,
      headers: {
        "WWW-Authenticate": `x402 realm="leash-devnet", merchant="${X402_MERCHANT_PUBKEY.toBase58()}", mint="${params.mint.toBase58()}", amount="${X402_CHALLENGE_AMOUNT.toString()}"`,
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function GET(request: NextRequest) {
  const configuredExpectedMint = getConfiguredExpectedMint();
  const allowSandboxMockMint = process.env.ALLOW_SANDBOX_MOCK_MINT === "true";

  const callerMintParam =
    request.headers.get("x-402-mint")?.trim() ||
    request.nextUrl.searchParams.get("mint")?.trim() ||
    null;

  const vaultHeader = request.headers.get("x-402-vault")?.trim() || null;
  const nonceHeader = request.headers.get("x-402-nonce")?.trim() || null;
  const txSigHeader = request.headers.get("x-402-tx-signature")?.trim() || null;

  const fallbackNonce =
    nonceHeader && /^[a-zA-Z0-9_-]{8,64}$/.test(nonceHeader)
      ? nonceHeader
      : randomBytes(12).toString("hex");

  let expectedMint = configuredExpectedMint;
  let mintVerificationMode: MintVerificationMode = "strict_expected_mint";

  if (callerMintParam) {
    let parsedCallerMint: PublicKey;
    try {
      parsedCallerMint = new PublicKey(callerMintParam);
    } catch {
      return paymentRequiredResponse({
        mint: configuredExpectedMint,
        mintVerificationMode: "strict_expected_mint",
        nonce: fallbackNonce,
        reason: "Mint mismatch: malformed SPL mint public key in X-402-Mint / ?mint.",
      });
    }

    if (!parsedCallerMint.equals(configuredExpectedMint)) {
      if (!allowSandboxMockMint) {
        return paymentRequiredResponse({
          mint: configuredExpectedMint,
          mintVerificationMode: "strict_expected_mint",
          nonce: fallbackNonce,
          reason: `Mint mismatch: caller requested mint ${parsedCallerMint.toBase58()}, but server strictly enforces EXPECTED_MINT ${configuredExpectedMint.toBase58()} (ALLOW_SANDBOX_MOCK_MINT !== "true").`,
        });
      }
      expectedMint = parsedCallerMint;
      mintVerificationMode = "sandbox_mock_mint";
    }
  }

  // Unauthenticated request -> issue fresh HTTP 402 challenge bound to expectedMint
  if (!vaultHeader || !nonceHeader) {
    const freshNonce = randomBytes(12).toString("hex");
    return paymentRequiredResponse({
      mint: expectedMint,
      mintVerificationMode,
      nonce: freshNonce,
    });
  }

  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(nonceHeader)) {
    return paymentRequiredResponse({
      mint: expectedMint,
      mintVerificationMode,
      nonce: randomBytes(12).toString("hex"),
      reason: "Malformed X-402-Nonce format.",
    });
  }

  let vaultPubkey: PublicKey;
  try {
    vaultPubkey = new PublicKey(vaultHeader);
  } catch {
    return paymentRequiredResponse({
      mint: expectedMint,
      mintVerificationMode,
      nonce: nonceHeader,
      reason: "Invalid X-402-Vault header: malformed Solana public key.",
    });
  }

  // Recompute canonical mint-bound request_hash server-side
  const { preimage, hashBytes, hashHex } = computeChallengeHash(
    expectedMint,
    nonceHeader
  );
  const replayKey = `leash:x402:receipt:${hashHex}`;

  // Pre-RPC fast check: reject already-redeemed Receipt without burning RPC calls
  try {
    const alreadyRedeemed = await peekKeyTtlSeconds(replayKey);
    if (alreadyRedeemed.exists) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: randomBytes(12).toString("hex"),
        reason:
          "Receipt already redeemed — single-use x402 settlement enforced.",
      });
    }
  } catch (kvErr: unknown) {
    return NextResponse.json(
      {
        status: 503,
        verified: false,
        error: "Replay Protection Store Unavailable (Failing Closed)",
        detail: kvErr instanceof Error ? kvErr.message : String(kvErr),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  const [expectedReceiptPda, expectedBump] = deriveReceiptPda(
    vaultPubkey,
    hashBytes,
    LEASH_PROGRAM_ID
  );

  // Always use server-configured RPC (never trust client-supplied RPC headers)
  const rpcUrl =
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    DEFAULT_DEVNET_RPC;

  const connection = new Connection(rpcUrl, "confirmed");

  try {
    const [receiptAccount, vaultAccount, currentSlot] = await Promise.all([
      connection.getAccountInfo(expectedReceiptPda, "confirmed"),
      connection.getAccountInfo(vaultPubkey, "confirmed"),
      connection.getSlot("confirmed"),
    ]);

    if (!receiptAccount) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `On-chain Receipt PDA (${expectedReceiptPda.toBase58()}) does NOT exist on Devnet. Note: Leash circuit-breaker trips commit with tx.meta.err == null but allocate zero Receipt PDA — non-reverting x402 bypass blocked.`,
      });
    }

    if (!receiptAccount.owner.equals(LEASH_PROGRAM_ID)) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Receipt account owner (${receiptAccount.owner.toBase58()}) does not match Leash Program ID (${LEASH_PROGRAM_ID.toBase58()}).`,
      });
    }

    if (!vaultAccount) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `On-chain Vault account (${vaultPubkey.toBase58()}) does not exist on Devnet.`,
      });
    }

    if (!vaultAccount.owner.equals(LEASH_PROGRAM_ID)) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Vault account owner (${vaultAccount.owner.toBase58()}) does not match Leash Program ID (${LEASH_PROGRAM_ID.toBase58()}).`,
      });
    }

    const decodedReceipt = decodeReceipt(
      expectedReceiptPda,
      new Uint8Array(receiptAccount.data)
    );
    const decodedVault = decodeVault(
      vaultPubkey,
      new Uint8Array(vaultAccount.data)
    );

    const [canonicalVaultPda, canonicalVaultBump] = deriveVaultPda(
      decodedVault.owner,
      LEASH_PROGRAM_ID
    );
    if (
      !canonicalVaultPda.equals(vaultPubkey) ||
      decodedVault.bump !== canonicalVaultBump
    ) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: "Vault canonical PDA verification failed.",
      });
    }

    if (decodedReceipt.bump !== expectedBump) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: "Receipt canonical PDA bump verification failed.",
      });
    }

    if (!decodedReceipt.vault.equals(vaultPubkey)) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Receipt vault mismatch: expected ${vaultPubkey.toBase58()}, got ${decodedReceipt.vault.toBase58()}.`,
      });
    }

    if (!decodedVault.mint.equals(expectedMint)) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Mint mismatch: on-chain Vault (${vaultPubkey.toBase58()}) settles mint ${decodedVault.mint.toBase58()}, expected ${expectedMint.toBase58()}.`,
      });
    }

    if (!decodedReceipt.merchant.equals(X402_MERCHANT_PUBKEY)) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Receipt merchant mismatch: expected ${X402_MERCHANT_PUBKEY.toBase58()}, got ${decodedReceipt.merchant.toBase58()}.`,
      });
    }

    if (decodedReceipt.amount !== X402_CHALLENGE_AMOUNT) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Receipt settled amount mismatch: expected ${X402_CHALLENGE_AMOUNT.toString()}, got ${decodedReceipt.amount.toString()}.`,
      });
    }

    if (decodedReceipt.requestHashHex !== hashHex) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Receipt request_hash mismatch: expected ${hashHex}, got ${decodedReceipt.requestHashHex}.`,
      });
    }

    if (BigInt(currentSlot) >= decodedReceipt.expirySlot) {
      return paymentRequiredResponse({
        mint: expectedMint,
        mintVerificationMode,
        nonce: nonceHeader,
        reason: `Receipt expired: current Devnet slot ${currentSlot} >= expiry_slot ${decodedReceipt.expirySlot.toString()}.`,
      });
    }

    // Atomic serverless SET key "1" EX ttl NX claim across concurrent instances (fails closed on Redis error)
    const redemption = await redeemReceiptAtomically(
      replayKey,
      REDEEMED_RECEIPT_TTL_SECONDS
    );
    if (!redemption.ok) {
      if (redemption.reason === "already_redeemed") {
        return paymentRequiredResponse({
          mint: expectedMint,
          mintVerificationMode,
          nonce: randomBytes(12).toString("hex"),
          reason: redemption.error,
        });
      }
      return NextResponse.json(
        {
          status: 503,
          verified: false,
          error: "Replay Protection Store Unavailable (Failing Closed)",
          detail: redemption.error,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
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
          vault: decodedReceipt.vault.toBase58(),
          session: decodedReceipt.session.toBase58(),
          merchant: decodedReceipt.merchant.toBase58(),
          mint: decodedVault.mint.toBase58(),
          mintVerificationMode,
          replayStore: redemption.storeMode,
          amountSettled: decodedReceipt.amount.toString(),
          canonicalPreimage: preimage,
          requestHashHex: decodedReceipt.requestHashHex,
          currentSlot,
          expirySlot: Number(decodedReceipt.expirySlot),
          rentPayer: decodedReceipt.rentPayer.toBase58(),
          txSignature: txSigHeader ?? null,
        },
        data: {
          feed: "solana-x402-autonomous-execution-signal",
          timestamp: new Date().toISOString(),
          settlementGuarantee:
            "Verified directly via canonical on-chain Leash Vault + Receipt PDAs and atomic SET NX EX replay guard.",
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

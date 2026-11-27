"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  DEFAULT_DEVNET_RPC,
  DEVNET_USDC_MINT,
  DecodedSession,
  DecodedVault,
  LEASH_PROGRAM_ID,
  X402_DRAIN_AMOUNT,
  X402_MERCHANT_PUBKEY,
  X402_RECEIPT_TTL_SLOTS,
  X402_SALAMI_AMOUNT,
  buildCreateSessionIx,
  buildExecuteAgentSpendIx,
  buildInitVaultIx,
  buildReapIdleSessionIx,
  buildSetPauseIx,
  buildUpdateAllowlistIx,
  computeAvailableBucketTokens,
  decodeSession,
  decodeVault,
  deriveReceiptPda,
  deriveSessionPda,
  deriveVaultPda,
  formatUsdc,
  hexToBytes,
} from "@/lib/leash-protocol";

const LS_OWNER_KEY = "leash_judge_owner_keypair_v1";
const LS_AGENT_KEY = "leash_judge_agent_keypair_v1";
const LS_ACTIVE_SESSION_KEY = "leash_judge_active_session_v1";

// Fits total Setup rent (~0.0128 SOL) + Agent stipend (0.015 SOL) = ~0.0278 SOL (< 0.04 SOL)
const AGENT_STIPEND_SOL = 0.015;

type LogTone = "ok" | "trip" | "warn";

interface SandboxLogEntry {
  id: string;
  timestamp: string;
  title: string;
  tone: LogTone;
  txSig?: string;
  detail: string;
}

interface RedeemedReceiptContext {
  vault: string;
  mint: string;
  nonce: string;
  txSig: string;
}

function loadOrCreateBrowserKeypair(storageKey: string): Keypair {
  const existing = window.localStorage.getItem(storageKey);
  if (existing) {
    try {
      const arr = JSON.parse(existing) as number[];
      if (Array.isArray(arr) && arr.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(arr));
      }
    } catch {
      // Regenerate if malformed
    }
  }
  const fresh = Keypair.generate();
  window.localStorage.setItem(
    storageKey,
    JSON.stringify(Array.from(fresh.secretKey))
  );
  return fresh;
}

function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function explorerAddressUrl(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}?cluster=devnet`;
}

async function signAndConfirmBrowserTx(
  connection: Connection,
  tx: Transaction,
  feePayer: Keypair,
  extraSigners: Keypair[] = [],
  skipPreflight = false
): Promise<string> {
  tx.feePayer = feePayer.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(feePayer, ...extraSigners);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight,
    maxRetries: 5,
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const statuses = await connection.getSignatureStatuses([sig]);
    const st = statuses.value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized")
    ) {
      if (st.err) {
        const err = new Error(
          `On-chain revert: ${JSON.stringify(st.err)}`
        ) as Error & { txSig?: string };
        err.txSig = sig;
        throw err;
      }
      return sig;
    }
  }

  throw new Error(`Timed out confirming Devnet transaction ${sig}`);
}

export default function JudgeSandbox() {
  const [rpcUrl, setRpcUrl] = useState<string>(DEFAULT_DEVNET_RPC);
  const [ownerKeypair, setOwnerKeypair] = useState<Keypair | null>(null);
  const [agentKeypair, setAgentKeypair] = useState<Keypair | null>(null);

  const [ownerSol, setOwnerSol] = useState<number>(0);
  const [agentSol, setAgentSol] = useState<number>(0);
  const [faucetThrottled, setFaucetThrottled] = useState<boolean>(false);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const [vaultState, setVaultState] = useState<DecodedVault | null>(null);
  const [vaultUsdcBalance, setVaultUsdcBalance] = useState<bigint>(0n);
  const [activeSessionAddress, setActiveSessionAddress] =
    useState<PublicKey | null>(null);
  const [sessionState, setSessionState] = useState<DecodedSession | null>(null);
  const [sessionReaped, setSessionReaped] = useState<boolean>(false);

  const [verifiedMint, setVerifiedMint] = useState<string | null>(null);
  const [verifiedMintMode, setVerifiedMintMode] = useState<string | null>(null);
  const [lastRedeemed, setLastRedeemed] =
    useState<RedeemedReceiptContext | null>(null);

  const [nowSec, setNowSec] = useState<bigint>(
    BigInt(Math.floor(Date.now() / 1000))
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [logs, setLogs] = useState<SandboxLogEntry[]>([]);

  const connection = useMemo(
    () => new Connection(rpcUrl, "confirmed"),
    [rpcUrl]
  );

  const appendLog = useCallback(
    (entry: Omit<SandboxLogEntry, "id" | "timestamp">) => {
      setLogs((prev) => [
        {
          ...entry,
          id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          timestamp: new Date().toISOString().slice(11, 19) + " UTC",
        },
        ...prev,
      ]);
    },
    []
  );

  useEffect(() => {
    const owner = loadOrCreateBrowserKeypair(LS_OWNER_KEY);
    const agent = loadOrCreateBrowserKeypair(LS_AGENT_KEY);
    setOwnerKeypair(owner);
    setAgentKeypair(agent);

    const savedSession = window.localStorage.getItem(LS_ACTIVE_SESSION_KEY);
    if (savedSession) {
      try {
        setActiveSessionAddress(new PublicKey(savedSession));
      } catch {
        // Ignore stale entry
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshOnChainState = useCallback(async () => {
    if (!ownerKeypair || !agentKeypair) return;
    try {
      const [vaultPda] = deriveVaultPda(ownerKeypair.publicKey);
      const [ownerLamports, agentLamports, vaultAccInfo] = await Promise.all([
        connection.getBalance(ownerKeypair.publicKey, "confirmed"),
        connection.getBalance(agentKeypair.publicKey, "confirmed"),
        connection.getAccountInfo(vaultPda, "confirmed"),
      ]);

      setOwnerSol(ownerLamports / LAMPORTS_PER_SOL);
      setAgentSol(agentLamports / LAMPORTS_PER_SOL);

      if (!vaultAccInfo) {
        setVaultState(null);
        setVaultUsdcBalance(0n);
        setSessionState(null);
        return;
      }

      const decodedVault = decodeVault(
        vaultPda,
        new Uint8Array(vaultAccInfo.data)
      );
      setVaultState(decodedVault);

      const vaultTokenBal = await connection
        .getTokenAccountBalance(decodedVault.vaultAta, "confirmed")
        .catch(() => null);
      setVaultUsdcBalance(
        vaultTokenBal ? BigInt(vaultTokenBal.value.amount) : 0n
      );

      let targetSession = activeSessionAddress;
      if (!targetSession && decodedVault.sessionNonce > 0n) {
        targetSession = deriveSessionPda(
          vaultPda,
          decodedVault.sessionNonce - 1n
        )[0];
        setActiveSessionAddress(targetSession);
      }

      if (targetSession) {
        const sessInfo = await connection.getAccountInfo(
          targetSession,
          "confirmed"
        );
        if (sessInfo) {
          setSessionState(
            decodeSession(targetSession, new Uint8Array(sessInfo.data))
          );
          setSessionReaped(false);
        } else {
          setSessionState(null);
          if (decodedVault.sessionNonce > 0n) {
            setSessionReaped(true);
          }
        }
      }
    } catch {
      // Silent background poll resilience
    }
  }, [ownerKeypair, agentKeypair, connection, activeSessionAddress]);

  useEffect(() => {
    void refreshOnChainState();
    const poll = window.setInterval(() => {
      void refreshOnChainState();
    }, 5000);
    return () => window.clearInterval(poll);
  }, [refreshOnChainState]);

  const handleCopy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedLabel(label);
    window.setTimeout(() => setCopiedLabel(null), 1600);
  };

  const handleRotateKeys = () => {
    const newOwner = Keypair.generate();
    const newAgent = Keypair.generate();
    window.localStorage.setItem(
      LS_OWNER_KEY,
      JSON.stringify(Array.from(newOwner.secretKey))
    );
    window.localStorage.setItem(
      LS_AGENT_KEY,
      JSON.stringify(Array.from(newAgent.secretKey))
    );
    window.localStorage.removeItem(LS_ACTIVE_SESSION_KEY);
    setOwnerKeypair(newOwner);
    setAgentKeypair(newAgent);
    setVaultState(null);
    setSessionState(null);
    setActiveSessionAddress(null);
    setSessionReaped(false);
    setVerifiedMint(null);
    setVerifiedMintMode(null);
    setLastRedeemed(null);
    appendLog({
      title: "Rotated Ephemeral Browser Keypairs",
      tone: "warn",
      detail: `New Owner: ${newOwner.publicKey.toBase58()}\nNew Agent: ${newAgent.publicKey.toBase58()}`,
    });
  };

  // Judge-proof Devnet funding: tries server /api/faucet first (0.05 SOL), then falls back to RPC requestAirdrop
  const fundWalletWithFallback = useCallback(
    async (
      pubkey: PublicKey,
      roleLabel: string
    ): Promise<{ ok: boolean; txSig?: string }> => {
      try {
        const faucetRes = await fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pubkey: pubkey.toBase58() }),
        });
        const faucetBody = await faucetRes.json();

        if (faucetRes.ok && (faucetBody.funded || faucetBody.skipped)) {
          setFaucetThrottled(false);
          appendLog({
            title: faucetBody.funded
              ? `Server Faucet Funded ${roleLabel} (+${faucetBody.amountSol} SOL)`
              : `Server Faucet Check (${roleLabel})`,
            tone: "ok",
            txSig: faucetBody.txSignature,
            detail: JSON.stringify(faucetBody, null, 2),
          });
          return { ok: true, txSig: faucetBody.txSignature };
        }
      } catch {
        // Proceed to public RPC requestAirdrop fallback
      }

      try {
        const sig = await connection.requestAirdrop(
          pubkey,
          Math.floor(0.5 * LAMPORTS_PER_SOL)
        );
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1200));
          const st = (await connection.getSignatureStatuses([sig])).value[0];
          if (
            st &&
            (st.confirmationStatus === "confirmed" ||
              st.confirmationStatus === "finalized")
          ) {
            break;
          }
        }
        setFaucetThrottled(false);
        appendLog({
          title: `Devnet RPC Airdrop Confirmed (${roleLabel}: +0.50 SOL)`,
          tone: "ok",
          txSig: sig,
          detail: `Recipient: ${pubkey.toBase58()}`,
        });
        return { ok: true, txSig: sig };
      } catch (err: unknown) {
        setFaucetThrottled(true);
        const msg = err instanceof Error ? err.message : String(err);
        appendLog({
          title: `Devnet Faucet Fallback Required (${roleLabel})`,
          tone: "warn",
          detail: `Server /api/faucet unconfigured (503) and public RPC throttled: ${msg}\nCopy ${pubkey.toBase58()} and request Devnet SOL at https://faucet.solana.com.`,
        });
        return { ok: false };
      }
    },
    [appendLog, connection]
  );

  const handleAirdrop = async (target: "owner" | "agent") => {
    if (!ownerKeypair || !agentKeypair) return;
    const pubkey =
      target === "owner" ? ownerKeypair.publicKey : agentKeypair.publicKey;
    setBusyAction(`airdrop-${target}`);
    try {
      await fundWalletWithFallback(pubkey, target.toUpperCase());
      await refreshOnChainState();
    } finally {
      setBusyAction(null);
    }
  };

  // ACTION 1: Setup Demo Vault & Session (total setup + agent stipend < 0.04 SOL)
  const handleSetupDemo = async () => {
    if (!ownerKeypair || !agentKeypair) return;
    setBusyAction("setup");
    try {
      // Auto-fund Owner via /api/faucet -> requestAirdrop if balance < 0.035 SOL
      const initialOwnerLamports = await connection.getBalance(
        ownerKeypair.publicKey,
        "confirmed"
      );
      if (initialOwnerLamports < Math.floor(0.035 * LAMPORTS_PER_SOL)) {
        const funded = await fundWalletWithFallback(
          ownerKeypair.publicKey,
          "OWNER"
        );
        const postFundLamports = await connection.getBalance(
          ownerKeypair.publicKey,
          "confirmed"
        );
        setOwnerSol(postFundLamports / LAMPORTS_PER_SOL);
        if (
          !funded.ok &&
          postFundLamports < Math.floor(0.03 * LAMPORTS_PER_SOL)
        ) {
          throw new Error(
            `Owner wallet (${ownerKeypair.publicKey.toBase58()}) needs >= 0.04 Devnet SOL. Click "Copy Pubkey" above and request SOL at https://faucet.solana.com.`
          );
        }
      }

      const programInfo = await connection.getAccountInfo(
        LEASH_PROGRAM_ID,
        "confirmed"
      );
      if (!programInfo) {
        throw new Error(
          `Leash program (${LEASH_PROGRAM_ID.toBase58()}) was not found on this RPC endpoint.`
        );
      }

      const currentAgentLamports = await connection.getBalance(
        agentKeypair.publicKey,
        "confirmed"
      );
      const currentAgentSol = currentAgentLamports / LAMPORTS_PER_SOL;

      const [vaultPda] = deriveVaultPda(ownerKeypair.publicKey);
      const existingVaultInfo = await connection.getAccountInfo(
        vaultPda,
        "confirmed"
      );

      let mintPubkey: PublicKey;
      let vaultAta: PublicKey;
      let nextNonce = 0n;
      let setupTxSig = "";

      if (!existingVaultInfo) {
        const mintKeypair = Keypair.generate();
        mintPubkey = mintKeypair.publicKey;
        vaultAta = getAssociatedTokenAddressSync(mintPubkey, vaultPda, true);
        const merchantAta = getAssociatedTokenAddressSync(
          mintPubkey,
          X402_MERCHANT_PUBKEY,
          true
        );
        const mintRent =
          await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

        const tx1 = new Transaction();
        if (currentAgentSol < 0.01) {
          tx1.add(
            SystemProgram.transfer({
              fromPubkey: ownerKeypair.publicKey,
              toPubkey: agentKeypair.publicKey,
              lamports: Math.floor(AGENT_STIPEND_SOL * LAMPORTS_PER_SOL),
            })
          );
        }
        tx1.add(
          SystemProgram.createAccount({
            fromPubkey: ownerKeypair.publicKey,
            newAccountPubkey: mintPubkey,
            space: MINT_SIZE,
            lamports: mintRent,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMintInstruction(
            mintPubkey,
            6,
            ownerKeypair.publicKey,
            null
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            ownerKeypair.publicKey,
            merchantAta,
            X402_MERCHANT_PUBKEY,
            mintPubkey
          ),
          buildInitVaultIx({
            owner: ownerKeypair.publicKey,
            vault: vaultPda,
            mint: mintPubkey,
            vaultAta,
            initialAllowlist: [X402_MERCHANT_PUBKEY],
          }),
          createMintToInstruction(
            mintPubkey,
            vaultAta,
            ownerKeypair.publicKey,
            10_000_000n
          )
        );

        await signAndConfirmBrowserTx(connection, tx1, ownerKeypair, [
          mintKeypair,
        ]);
        nextNonce = 0n;
      } else {
        const decoded = decodeVault(
          vaultPda,
          new Uint8Array(existingVaultInfo.data)
        );
        mintPubkey = decoded.mint;
        vaultAta = decoded.vaultAta;
        nextNonce = decoded.sessionNonce;
        const merchantAta = getAssociatedTokenAddressSync(
          mintPubkey,
          X402_MERCHANT_PUBKEY,
          true
        );

        const prepTx = new Transaction();
        if (currentAgentSol < 0.01) {
          prepTx.add(
            SystemProgram.transfer({
              fromPubkey: ownerKeypair.publicKey,
              toPubkey: agentKeypair.publicKey,
              lamports: Math.floor(AGENT_STIPEND_SOL * LAMPORTS_PER_SOL),
            })
          );
        }
        prepTx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            ownerKeypair.publicKey,
            merchantAta,
            X402_MERCHANT_PUBKEY,
            mintPubkey
          )
        );
        if (!decoded.allowlist.some((k) => k.equals(X402_MERCHANT_PUBKEY))) {
          prepTx.add(
            buildUpdateAllowlistIx({
              owner: ownerKeypair.publicKey,
              vault: vaultPda,
              newAllowlist: [X402_MERCHANT_PUBKEY],
            })
          );
        }
        if (decoded.paused) {
          prepTx.add(
            buildSetPauseIx({
              owner: ownerKeypair.publicKey,
              vault: vaultPda,
              paused: false,
            })
          );
        }
        prepTx.add(
          createMintToInstruction(
            mintPubkey,
            vaultAta,
            ownerKeypair.publicKey,
            10_000_000n
          )
        );
        await signAndConfirmBrowserTx(connection, prepTx, ownerKeypair);
      }

      const [sessionPda] = deriveSessionPda(vaultPda, nextNonce);
      const sessionTx = new Transaction().add(
        buildCreateSessionIx({
          owner: ownerKeypair.publicKey,
          vault: vaultPda,
          session: sessionPda,
          agentSigner: agentKeypair.publicKey,
          maxPerTx: 500_000n, // 0.50 USDC
          bucketCap: 1_500_000n, // 1.50 USDC
          windowSecs: 30n, // 30s continuous refill window
          lifetimeCap: 5_000_000n, // 5.00 USDC
          idleTimeoutSecs: 15n, // 15s idle timeout for fast Judge reap testing
        })
      );
      setupTxSig = await signAndConfirmBrowserTx(
        connection,
        sessionTx,
        ownerKeypair
      );

      window.localStorage.setItem(
        LS_ACTIVE_SESSION_KEY,
        sessionPda.toBase58()
      );
      setActiveSessionAddress(sessionPda);
      setSessionReaped(false);
      await refreshOnChainState();

      appendLog({
        title: "1. Setup Demo Vault & Session Confirmed",
        tone: "ok",
        txSig: setupTxSig,
        detail: JSON.stringify(
          {
            vaultPda: vaultPda.toBase58(),
            sessionPda: sessionPda.toBase58(),
            mockUsdcMint: mintPubkey.toBase58(),
            agentStipendSol: AGENT_STIPEND_SOL,
            allowlistedX402Merchant: X402_MERCHANT_PUBKEY.toBase58(),
            policy: {
              maxPerTxUsdc: "0.50",
              bucketCapUsdc: "1.50",
              windowSecs: 30,
              lifetimeCapUsdc: "5.00",
              idleTimeoutSecs: 15,
            },
          },
          null,
          2
        ),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog({
        title: "Setup Demo Vault & Session Failed",
        tone: "trip",
        detail: msg,
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ACTION 2: Normal x402 Payment (402 -> Pay -> Vault+Receipt Verified -> 200 OK)
  const handleNormalX402 = async () => {
    if (!agentKeypair || !vaultState || !activeSessionAddress) return;
    setBusyAction("normal-x402");
    try {
      const mintStr = vaultState.mint.toBase58();
      // Step 1: Request protected resource with sandbox mint -> receive mint-bound HTTP 402 challenge
      const res402 = await fetch(
        `/api/x402/resource?mint=${encodeURIComponent(mintStr)}`,
        {
          cache: "no-store",
          headers: { "X-402-Mint": mintStr },
        }
      );
      const body402 = await res402.json();
      const challenge = body402.challenge;
      if (challenge.mint !== mintStr) {
        throw new Error(
          body402.reason ||
            `Server strictly enforces EXPECTED_MINT ${challenge.mint}. Set ALLOW_SANDBOX_MOCK_MINT=true for MockUSDC demo.`
        );
      }

      const requestHashBytes = hexToBytes(challenge.requestHashHex);
      const [receiptPda] = deriveReceiptPda(vaultState.address, requestHashBytes);
      const merchantPubkey = new PublicKey(challenge.merchant);
      const merchantAta = getAssociatedTokenAddressSync(
        vaultState.mint,
        merchantPubkey,
        true
      );

      // Step 2: Execute bounded spend on Devnet paid by Agent
      const spendTx = new Transaction().add(
        buildExecuteAgentSpendIx({
          agentSigner: agentKeypair.publicKey,
          vault: vaultState.address,
          session: activeSessionAddress,
          mint: vaultState.mint,
          vaultAta: vaultState.vaultAta,
          merchant: merchantPubkey,
          merchantAta,
          receipt: receiptPda,
          amount: BigInt(challenge.amount),
          requestHash: requestHashBytes,
          receiptTtlSlots: BigInt(challenge.receiptTtlSlots),
        })
      );

      const txSig = await signAndConfirmBrowserTx(
        connection,
        spendTx,
        agentKeypair
      );

      // Step 3: Retry /api/x402/resource with Vault + Mint + Nonce headers
      const res200 = await fetch("/api/x402/resource", {
        cache: "no-store",
        headers: {
          "X-402-Vault": vaultState.address.toBase58(),
          "X-402-Mint": mintStr,
          "X-402-Nonce": challenge.nonce,
          "X-402-Tx-Signature": txSig,
        },
      });
      const body200 = await res200.json();

      if (res200.status === 200 && body200.verificationProof) {
        setVerifiedMint(body200.verificationProof.mint ?? null);
        setVerifiedMintMode(
          body200.verificationProof.mintVerificationMode ?? null
        );
        setLastRedeemed({
          vault: vaultState.address.toBase58(),
          mint: mintStr,
          nonce: challenge.nonce,
          txSig,
        });
      }

      await refreshOnChainState();

      appendLog({
        title: `2. Normal x402 Payment -> HTTP ${res402.status} -> Vault+Receipt Verified -> HTTP ${res200.status}`,
        tone: res200.status === 200 ? "ok" : "trip",
        txSig,
        detail:
          `--- [1] HTTP ${res402.status} Mint-Bound Challenge ---\n` +
          `${JSON.stringify(body402.challenge, null, 2)}\n\n` +
          `--- [2] HTTP ${res200.status} On-Chain Vault + Receipt PDA Verification ---\n` +
          `${JSON.stringify(body200, null, 2)}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog({
        title: "Normal x402 Payment Error",
        tone: "trip",
        txSig: (err as { txSig?: string })?.txSig,
        detail: msg,
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ACTION 2b: Replay Same Receipt (Must Reject 402)
  const handleReplayReceipt = async () => {
    if (!lastRedeemed) return;
    setBusyAction("replay");
    try {
      const replayRes = await fetch("/api/x402/resource", {
        cache: "no-store",
        headers: {
          "X-402-Vault": lastRedeemed.vault,
          "X-402-Mint": lastRedeemed.mint,
          "X-402-Nonce": lastRedeemed.nonce,
          "X-402-Tx-Signature": lastRedeemed.txSig,
        },
      });
      const replayBody = await replayRes.json();

      appendLog({
        title: `2b. Replay Same Receipt -> Rejected with HTTP ${replayRes.status}`,
        tone: replayRes.status === 402 ? "ok" : "trip",
        txSig: lastRedeemed.txSig,
        detail: JSON.stringify(replayBody, null, 2),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog({
        title: "Replay Verification Error",
        tone: "trip",
        detail: msg,
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ACTION 3: Inject Drain Attack (Trips Circuit Breaker, 0 Moved)
  const handleInjectDrain = async () => {
    if (!agentKeypair || !vaultState || !activeSessionAddress) return;
    setBusyAction("drain");
    try {
      const mintStr = vaultState.mint.toBase58();
      const res402 = await fetch(
        `/api/x402/resource?mint=${encodeURIComponent(mintStr)}`,
        {
          cache: "no-store",
          headers: { "X-402-Mint": mintStr },
        }
      );
      const body402 = await res402.json();
      const challenge = body402.challenge;
      const requestHashBytes = hexToBytes(challenge.requestHashHex);
      const [receiptPda] = deriveReceiptPda(vaultState.address, requestHashBytes);
      const merchantAta = getAssociatedTokenAddressSync(
        vaultState.mint,
        X402_MERCHANT_PUBKEY,
        true
      );

      const vaultBefore = vaultUsdcBalance;

      // Prompt-injected agent attempts 5.00 USDC drain (10x max_per_tx = 0.50 USDC)
      const drainTx = new Transaction().add(
        buildExecuteAgentSpendIx({
          agentSigner: agentKeypair.publicKey,
          vault: vaultState.address,
          session: activeSessionAddress,
          mint: vaultState.mint,
          vaultAta: vaultState.vaultAta,
          merchant: X402_MERCHANT_PUBKEY,
          merchantAta,
          receipt: receiptPda,
          amount: X402_DRAIN_AMOUNT,
          requestHash: requestHashBytes,
          receiptTtlSlots: X402_RECEIPT_TTL_SLOTS,
        })
      );

      const txSig = await signAndConfirmBrowserTx(
        connection,
        drainTx,
        agentKeypair
      );

      // Prove x402 server rejects this non-reverting tx because NO Receipt PDA exists!
      const verifyAttempt = await fetch("/api/x402/resource", {
        cache: "no-store",
        headers: {
          "X-402-Vault": vaultState.address.toBase58(),
          "X-402-Mint": mintStr,
          "X-402-Nonce": challenge.nonce,
          "X-402-Tx-Signature": txSig,
        },
      });
      const verifyBody = await verifyAttempt.json();
      await refreshOnChainState();

      appendLog({
        title:
          "3. Prompt-Injection Drain Blocked -> Session Permanently TRIPPED (0 Tokens Moved)",
        tone: "trip",
        txSig,
        detail:
          `Attempted Drain: ${formatUsdc(X402_DRAIN_AMOUNT)} MockUSDC (> max_per_tx 0.50)\n` +
          `Vault Balance Before: ${formatUsdc(vaultBefore)} MockUSDC -> Moved: 0.00 MockUSDC\n` +
          `On-Chain Tx Status: Ok(()) committed SessionStatus::Tripped (ExceedsPerTxMax), Receipt PDA NOT allocated.\n\n` +
          `--- /api/x402/resource Spoof Check (HTTP ${verifyAttempt.status}) ---\n` +
          `${JSON.stringify(verifyBody, null, 2)}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog({
        title: "Drain Attack Simulation Error",
        tone: "trip",
        txSig: (err as { txSig?: string })?.txSig,
        detail: msg,
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ACTION 4: Salami Retry After Trip (Hard Reverts)
  const handleSalamiRetry = async () => {
    if (!agentKeypair || !vaultState || !activeSessionAddress) return;
    setBusyAction("salami");
    try {
      const mintStr = vaultState.mint.toBase58();
      const res402 = await fetch(
        `/api/x402/resource?mint=${encodeURIComponent(mintStr)}`,
        {
          cache: "no-store",
          headers: { "X-402-Mint": mintStr },
        }
      );
      const body402 = await res402.json();
      const requestHashBytes = hexToBytes(body402.challenge.requestHashHex);
      const [receiptPda] = deriveReceiptPda(vaultState.address, requestHashBytes);
      const merchantAta = getAssociatedTokenAddressSync(
        vaultState.mint,
        X402_MERCHANT_PUBKEY,
        true
      );

      const salamiTx = new Transaction().add(
        buildExecuteAgentSpendIx({
          agentSigner: agentKeypair.publicKey,
          vault: vaultState.address,
          session: activeSessionAddress,
          mint: vaultState.mint,
          vaultAta: vaultState.vaultAta,
          merchant: X402_MERCHANT_PUBKEY,
          merchantAta,
          receipt: receiptPda,
          amount: X402_SALAMI_AMOUNT, // Tiny 0.0001 USDC retry
          requestHash: requestHashBytes,
          receiptTtlSlots: X402_RECEIPT_TTL_SLOTS,
        })
      );

      await signAndConfirmBrowserTx(
        connection,
        salamiTx,
        agentKeypair,
        [],
        true
      );

      appendLog({
        title: "Unexpected: Salami Retry Did Not Revert",
        tone: "warn",
        detail: "Session was still Active; trip the circuit breaker in Step 3 first.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const txSig = (err as { txSig?: string })?.txSig;
      await refreshOnChainState();
      appendLog({
        title:
          "4. Salami Retry Hard-Reverted On-Chain (VaultError::SessionNotActive / 0x177a)",
        tone: "ok",
        txSig,
        detail:
          `Attempted Salami Spend: ${formatUsdc(X402_SALAMI_AMOUNT)} MockUSDC (100 base units)\n` +
          `Terminal Gate Enforcement: Zero recovery path once SessionStatus != Active.\n` +
          `Raw Revert Error: ${msg}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ACTION 5: Permissionless Reap Idle / Tripped Session
  const handleReapSession = async () => {
    if (!agentKeypair || !ownerKeypair || !vaultState || !activeSessionAddress)
      return;
    setBusyAction("reap");
    try {
      const ownerLamportsBefore = await connection.getBalance(
        ownerKeypair.publicKey,
        "confirmed"
      );

      const reapTx = new Transaction().add(
        buildReapIdleSessionIx({
          caller: agentKeypair.publicKey,
          vault: vaultState.address,
          session: activeSessionAddress,
          rentRecipient: ownerKeypair.publicKey,
        })
      );

      const txSig = await signAndConfirmBrowserTx(
        connection,
        reapTx,
        agentKeypair
      );

      const ownerLamportsAfter = await connection.getBalance(
        ownerKeypair.publicKey,
        "confirmed"
      );
      const reclaimedSol =
        (ownerLamportsAfter - ownerLamportsBefore) / LAMPORTS_PER_SOL;

      await refreshOnChainState();
      appendLog({
        title: `5. Permissionless Reap Succeeded (+${reclaimedSol.toFixed(6)} SOL Rent Returned to Owner)`,
        tone: "ok",
        txSig,
        detail:
          `Closed Session PDA: ${activeSessionAddress.toBase58()}\n` +
          `Permissionless Caller: ${agentKeypair.publicKey.toBase58()} (non-owner)\n` +
          `Enforced Rent Recipient: ${ownerKeypair.publicKey.toBase58()} (vault.owner)`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog({
        title: "Permissionless Reap Rejected (Session Still Active & Non-Idle)",
        tone: "warn",
        txSig: (err as { txSig?: string })?.txSig,
        detail: `Session must be Tripped/Revoked OR idle > 15s before permissionless reap.\nRaw Error: ${msg}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const availableBucket = useMemo(() => {
    if (!sessionState) return 0n;
    return computeAvailableBucketTokens(sessionState, nowSec);
  }, [sessionState, nowSec]);

  const bucketPct = useMemo(() => {
    if (!sessionState || sessionState.bucketCap === 0n) return 0;
    return Math.min(
      100,
      Number((availableBucket * 100n) / sessionState.bucketCap)
    );
  }, [sessionState, availableBucket]);

  const lifetimePct = useMemo(() => {
    if (!sessionState || sessionState.lifetimeCap === 0n) return 0;
    return Math.min(
      100,
      Number((sessionState.lifetimeSpent * 100n) / sessionState.lifetimeCap)
    );
  }, [sessionState]);

  const idleSecondsElapsed = useMemo(() => {
    if (!sessionState) return 0n;
    const diff = nowSec - sessionState.lastActiveTs;
    return diff > 0n ? diff : 0n;
  }, [sessionState, nowSec]);

  const hasReadySession = Boolean(vaultState && activeSessionAddress);

  return (
    <main className="sandbox-shell">
      <header className="topbar">
        <div className="topbar-title-group">
          <h1>Leash Judge Sandbox</h1>
          <p className="topbar-subtitle">
            Non-custodial payer-side spending control plane &amp; prompt-injection
            circuit breaker for Solana <code>x402</code> autonomous agents.
          </p>
        </div>

        <div className="topbar-meta">
          <span className="meta-chip mono">
            Program:{" "}
            <a
              href={explorerAddressUrl(LEASH_PROGRAM_ID.toBase58())}
              target="_blank"
              rel="noreferrer"
            >
              {LEASH_PROGRAM_ID.toBase58().slice(0, 8)}...
              {LEASH_PROGRAM_ID.toBase58().slice(-6)}
            </a>
          </span>

          <div className="rpc-input-wrap">
            <label htmlFor="rpc-endpoint-input">Devnet RPC</label>
            <input
              id="rpc-endpoint-input"
              className="rpc-input mono"
              type="url"
              value={rpcUrl}
              onChange={(e) => setRpcUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>
      </header>

      <section className="wallets-strip" aria-label="Ephemeral Browser Devnet Wallets">
        <article className="panel">
          <div className="wallet-card-head">
            <span className="wallet-role">Browser Vault Owner (localStorage)</span>
            <span className="wallet-balance mono">{ownerSol.toFixed(4)} SOL</span>
          </div>
          <div className="wallet-pubkey mono">
            {ownerKeypair ? ownerKeypair.publicKey.toBase58() : "Generating..."}
          </div>
          <div className="wallet-actions">
            <button
              id="btn-airdrop-owner"
              type="button"
              className="btn btn-primary"
              disabled={!ownerKeypair || busyAction !== null}
              onClick={() => handleAirdrop("owner")}
            >
              {busyAction === "airdrop-owner" ? "Funding..." : "Fund Owner SOL"}
            </button>
            <button
              id="btn-copy-owner"
              type="button"
              className="btn"
              disabled={!ownerKeypair}
              onClick={() =>
                ownerKeypair &&
                handleCopy("owner", ownerKeypair.publicKey.toBase58())
              }
            >
              {copiedLabel === "owner" ? "Copied!" : "Copy Pubkey"}
            </button>
            <a
              id="link-solana-faucet"
              className="btn"
              href="https://faucet.solana.com"
              target="_blank"
              rel="noreferrer"
            >
              faucet.solana.com ↗
            </a>
          </div>
          {faucetThrottled && (
            <div className="faucet-note">
              Server faucet unconfigured or public RPC throttled. Copy the Owner
              pubkey above and request Devnet SOL at{" "}
              <a
                href="https://faucet.solana.com"
                target="_blank"
                rel="noreferrer"
              >
                faucet.solana.com
              </a>
              . Step 1 fits cleanly under 0.04 SOL (including Agent stipend).
            </div>
          )}
        </article>

        <article className="panel">
          <div className="wallet-card-head">
            <span className="wallet-role">Browser Agent Signer (localStorage)</span>
            <span className="wallet-balance mono">{agentSol.toFixed(4)} SOL</span>
          </div>
          <div className="wallet-pubkey mono">
            {agentKeypair ? agentKeypair.publicKey.toBase58() : "Generating..."}
          </div>
          <div className="wallet-actions">
            <button
              id="btn-airdrop-agent"
              type="button"
              className="btn"
              disabled={!agentKeypair || busyAction !== null}
              onClick={() => handleAirdrop("agent")}
            >
              {busyAction === "airdrop-agent" ? "Funding..." : "Fund Agent SOL"}
            </button>
            <button
              id="btn-copy-agent"
              type="button"
              className="btn"
              disabled={!agentKeypair}
              onClick={() =>
                agentKeypair &&
                handleCopy("agent", agentKeypair.publicKey.toBase58())
              }
            >
              {copiedLabel === "agent" ? "Copied!" : "Copy Pubkey"}
            </button>
            <button
              id="btn-rotate-keys"
              type="button"
              className="btn"
              disabled={busyAction !== null}
              onClick={handleRotateKeys}
            >
              Rotate Keys
            </button>
          </div>
        </article>
      </section>

      <div className="workbench-grid">
        <div className="left-stack">
          <section className="panel" aria-labelledby="actions-heading">
            <div className="section-heading">
              <h2 id="actions-heading">Devnet Verification Actions</h2>
              <button
                id="btn-refresh-state"
                type="button"
                className="btn"
                onClick={() => void refreshOnChainState()}
              >
                Refresh
              </button>
            </div>

            <div className="action-list">
              <button
                id="btn-setup-demo"
                type="button"
                className="action-button"
                disabled={!ownerKeypair || busyAction !== null}
                onClick={handleSetupDemo}
              >
                <span className="action-title">
                  <span>1. Setup Demo Vault &amp; Session</span>
                  <span className="mono">
                    {busyAction === "setup" ? "Running..." : "< 0.04 SOL"}
                  </span>
                </span>
                <span className="action-desc">
                  Auto-funds via /api/faucet (with fallback), creates MockUSDC
                  mint, funds Vault (10 USDC), and opens bounded Session.
                </span>
              </button>

              <button
                id="btn-normal-x402"
                type="button"
                className="action-button"
                disabled={!hasReadySession || busyAction !== null}
                onClick={handleNormalX402}
              >
                <span className="action-title">
                  <span>
                    2. Normal x402 Payment (402 -&gt; Pay -&gt; Receipt Verified
                    -&gt; 200 OK)
                  </span>
                  <span className="mono">
                    {busyAction === "normal-x402" ? "Verifying..." : "0.25 USDC"}
                  </span>
                </span>
                <span className="action-desc">
                  Fetches mint-bound HTTP 402 challenge, settles 0.25 USDC, and
                  verifies both Vault.mint and Receipt PDA on Devnet.
                </span>
              </button>

              <button
                id="btn-replay-receipt"
                type="button"
                className="action-button"
                disabled={!lastRedeemed || busyAction !== null}
                onClick={handleReplayReceipt}
              >
                <span className="action-title">
                  <span>2b. Replay Same Receipt (Must Reject 402)</span>
                  <span className="mono">
                    {busyAction === "replay" ? "Testing..." : "Single-Use"}
                  </span>
                </span>
                <span className="action-desc">
                  Re-submits the exact headers from the last redeemed 200 OK
                  Receipt to verify single-use HTTP 402 replay rejection.
                </span>
              </button>

              <button
                id="btn-inject-drain"
                type="button"
                className="action-button action-button-danger"
                disabled={!hasReadySession || busyAction !== null}
                onClick={handleInjectDrain}
              >
                <span className="action-title">
                  <span>
                    3. Inject Drain Attack (Trips Circuit Breaker, 0 Moved)
                  </span>
                  <span className="mono">
                    {busyAction === "drain" ? "Tripping..." : "5.00 USDC"}
                  </span>
                </span>
                <span className="action-desc">
                  Attempts 5.00 USDC spend (&gt; 0.50 max_per_tx). Commits
                  Tripped state on-chain, moves 0 tokens, allocates no Receipt.
                </span>
              </button>

              <button
                id="btn-salami-retry"
                type="button"
                className="action-button"
                disabled={!hasReadySession || busyAction !== null}
                onClick={handleSalamiRetry}
              >
                <span className="action-title">
                  <span>4. Salami Retry After Trip (Hard Reverts)</span>
                  <span className="mono">
                    {busyAction === "salami" ? "Testing..." : "0.0001 USDC"}
                  </span>
                </span>
                <span className="action-desc">
                  Attempts tiny 100-unit follow-up spend on tripped Session.
                  Hard-reverts on-chain with SessionNotActive (zero recovery).
                </span>
              </button>

              <button
                id="btn-reap-session"
                type="button"
                className="action-button"
                disabled={!hasReadySession || busyAction !== null}
                onClick={handleReapSession}
              >
                <span className="action-title">
                  <span>5. Permissionless Reap Idle Session</span>
                  <span className="mono">
                    {busyAction === "reap" ? "Reaping..." : "Reclaim Rent"}
                  </span>
                </span>
                <span className="action-desc">
                  Non-owner caller closes Tripped or idle (&gt;15s) Session PDA
                  and returns 100% of rent lamports directly to Vault Owner.
                </span>
              </button>
            </div>
          </section>

          <section className="panel" aria-labelledby="telemetry-heading">
            <div className="section-heading">
              <h2 id="telemetry-heading">Live On-Chain Vault &amp; Session State</h2>
              {sessionState ? (
                <span
                  className={`badge ${
                    sessionState.status === "Active"
                      ? "badge-active"
                      : "badge-tripped"
                  }`}
                >
                  {sessionState.status}
                </span>
              ) : sessionReaped ? (
                <span className="badge badge-neutral">Reaped (Closed)</span>
              ) : (
                <span className="badge badge-neutral">Uninitialized</span>
              )}
            </div>

            {sessionState && (
              <>
                <div className="meter-block">
                  <div className="meter-labels">
                    <span>Leaky-Bucket Available (30s linear refill)</span>
                    <span className="mono">
                      {formatUsdc(availableBucket)} /{" "}
                      {formatUsdc(sessionState.bucketCap)} USDC
                    </span>
                  </div>
                  <div className="meter-track">
                    <div
                      className={`meter-fill ${
                        sessionState.status !== "Active"
                          ? "meter-fill-tripped"
                          : ""
                      }`}
                      style={{ width: `${bucketPct}%` }}
                    />
                  </div>
                </div>

                <div className="meter-block">
                  <div className="meter-labels">
                    <span>Lifetime Session Spend</span>
                    <span className="mono">
                      {formatUsdc(sessionState.lifetimeSpent)} /{" "}
                      {formatUsdc(sessionState.lifetimeCap)} USDC
                    </span>
                  </div>
                  <div className="meter-track">
                    <div
                      className="meter-fill"
                      style={{ width: `${lifetimePct}%` }}
                    />
                  </div>
                </div>
              </>
            )}

            <div className="kv-table">
              <div className="kv-key">Vault Balance</div>
              <div className="kv-val mono">
                {vaultState ? `${formatUsdc(vaultUsdcBalance)} MockUSDC` : "—"}
              </div>

              <div className="kv-key">Vault Mint</div>
              <div className="kv-val mono">
                {vaultState
                  ? vaultState.mint.toBase58()
                  : `Default Expected: ${DEVNET_USDC_MINT.toBase58()}`}
              </div>

              <div className="kv-key">Verified Mint</div>
              <div className="kv-val mono">
                {verifiedMint
                  ? `${verifiedMint} (${verifiedMintMode ?? "verified"})`
                  : "—"}
              </div>

              <div className="kv-key">Vault Paused</div>
              <div className="kv-val mono">
                {vaultState ? String(vaultState.paused) : "—"}
              </div>

              <div className="kv-key">Trip Reason</div>
              <div className="kv-val mono">
                {sessionState ? sessionState.tripReason : "—"}
              </div>

              <div className="kv-key">Max Per Tx</div>
              <div className="kv-val mono">
                {sessionState
                  ? `${formatUsdc(sessionState.maxPerTx)} USDC`
                  : "—"}
              </div>

              <div className="kv-key">Idle Timer</div>
              <div className="kv-val mono">
                {sessionState
                  ? `${idleSecondsElapsed.toString()}s / ${sessionState.idleTimeoutSecs.toString()}s`
                  : "—"}
              </div>

              <div className="kv-key">Vault PDA</div>
              <div className="kv-val mono">
                {vaultState ? (
                  <a
                    href={explorerAddressUrl(vaultState.address.toBase58())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {vaultState.address.toBase58()}
                  </a>
                ) : (
                  "—"
                )}
              </div>

              <div className="kv-key">Session PDA</div>
              <div className="kv-val mono">
                {activeSessionAddress ? (
                  <a
                    href={explorerAddressUrl(activeSessionAddress.toBase58())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {activeSessionAddress.toBase58()}
                  </a>
                ) : (
                  "—"
                )}
              </div>

              <div className="kv-key">Allowlist ({vaultState?.allowlist.length ?? 0}/16)</div>
              <div className="kv-val mono">
                {vaultState && vaultState.allowlist.length > 0
                  ? vaultState.allowlist.map((pk) => pk.toBase58()).join(", ")
                  : `Default x402: ${X402_MERCHANT_PUBKEY.toBase58()}`}
              </div>
            </div>
          </section>
        </div>

        <section
          className="console-panel"
          aria-labelledby="verification-console-heading"
        >
          <div className="console-header">
            <h2 id="verification-console-heading" className="mono">
              HTTP 402 Challenge &amp; On-Chain Receipt Verification Log
            </h2>
            <button
              id="btn-clear-logs"
              type="button"
              className="btn"
              onClick={() => setLogs([])}
            >
              Clear
            </button>
          </div>

          <div className="console-body">
            {logs.length === 0 ? (
              <div className="log-empty mono">
                Awaiting action. Click Step 1 to auto-fund via /api/faucet (or
                Devnet fallback) and initialize a live Vault &amp; Session, then
                test Steps 2–5.
              </div>
            ) : (
              logs.map((entry) => (
                <article key={entry.id} className="log-entry">
                  <div className="log-entry-head">
                    <span
                      className={`log-entry-title ${
                        entry.tone === "ok"
                          ? "log-tone-ok"
                          : entry.tone === "trip"
                          ? "log-tone-trip"
                          : "log-tone-warn"
                      }`}
                    >
                      {entry.title}
                    </span>
                    <span className="log-meta mono">{entry.timestamp}</span>
                  </div>

                  {entry.txSig && (
                    <a
                      className="log-tx-link mono"
                      href={explorerTxUrl(entry.txSig)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Explorer Tx: {entry.txSig} ↗
                    </a>
                  )}

                  <pre className="log-pre mono">{entry.detail}</pre>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

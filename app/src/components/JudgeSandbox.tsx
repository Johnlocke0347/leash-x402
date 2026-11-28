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

interface ServerStatusPayload {
  programId: string;
  cluster: string;
  rpcMode: "custom_rpc" | "public_devnet";
  faucet: {
    configured: boolean;
    pubkey?: string;
    balanceSol?: number;
  };
  replayStore: "upstash_redis" | "in_memory_fallback";
  mintPolicy: {
    mode: "sandbox_mock_mint" | "strict_usdc";
    expectedMint: string;
  };
}

interface TraceLogEntry {
  id: string;
  timestamp: string;
  title: string;
  badgeLabel: string;
  tone: LogTone;
  deltaSummary: string;
  mintSummary: string;
  receiptSummary: string;
  txSig?: string;
  rawJson: string;
}

interface RedeemedReceiptContext {
  vault: string;
  mint: string;
  nonce: string;
  txSig: string;
  receiptPda: string;
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

function shortKey(key: string): string {
  if (key.length <= 14) return key;
  return `${key.slice(0, 6)}...${key.slice(-6)}`;
}

function formatRpcHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || "devnet-rpc";
  } catch {
    return "devnet-rpc";
  }
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
  const rpcUrl = DEFAULT_DEVNET_RPC;
  const [serverStatus, setServerStatus] = useState<ServerStatusPayload | null>(
    null
  );

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
  const [completedSteps, setCompletedSteps] = useState<Record<number, boolean>>(
    {}
  );

  // Hydration-safe clock state: initialized to 0n on SSR and populated on client mount
  const [nowSec, setNowSec] = useState<bigint>(0n);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [logs, setLogs] = useState<TraceLogEntry[]>([]);

  const connection = useMemo(
    () => new Connection(rpcUrl, "confirmed"),
    [rpcUrl]
  );

  const appendTrace = useCallback(
    (entry: Omit<TraceLogEntry, "id" | "timestamp">) => {
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

  const markStepDone = useCallback((stepNum: number) => {
    setCompletedSteps((prev) => ({ ...prev, [stepNum]: true }));
  }, []);

  const fetchServerStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as ServerStatusPayload;
        setServerStatus(data);
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  useEffect(() => {
    const owner = loadOrCreateBrowserKeypair(LS_OWNER_KEY);
    const agent = loadOrCreateBrowserKeypair(LS_AGENT_KEY);
    setOwnerKeypair(owner);
    setAgentKeypair(agent);
    setNowSec(BigInt(Math.floor(Date.now() / 1000)));

    const savedSession = window.localStorage.getItem(LS_ACTIVE_SESSION_KEY);
    if (savedSession) {
      try {
        setActiveSessionAddress(new PublicKey(savedSession));
      } catch {
        // Ignore stale entry
      }
    }

    void fetchServerStatus();
  }, [fetchServerStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshOnChainState = useCallback(
    async (overrideSession?: PublicKey) => {
      if (!ownerKeypair || !agentKeypair) return;
      try {
        const [vaultPda] = deriveVaultPda(ownerKeypair.publicKey);
        const primaryInfos = await connection.getMultipleAccountsInfo(
          [ownerKeypair.publicKey, agentKeypair.publicKey, vaultPda],
          "confirmed"
        );

        const ownerLamports = primaryInfos[0]?.lamports ?? 0;
        const agentLamports = primaryInfos[1]?.lamports ?? 0;
        const vaultAccInfo = primaryInfos[2];

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

        let targetSession = overrideSession ?? activeSessionAddress;
        if (!targetSession && decodedVault.sessionNonce > 0n) {
          targetSession = deriveSessionPda(
            vaultPda,
            decodedVault.sessionNonce - 1n
          )[0];
          setActiveSessionAddress(targetSession);
        }

        const secondaryKeys = targetSession
          ? [decodedVault.vaultAta, targetSession]
          : [decodedVault.vaultAta];
        const secondaryInfos = await connection.getMultipleAccountsInfo(
          secondaryKeys,
          "confirmed"
        );

        const vaultAtaInfo = secondaryInfos[0];
        if (vaultAtaInfo && vaultAtaInfo.data.length >= 72) {
          const ataBytes = new Uint8Array(vaultAtaInfo.data);
          const ataView = new DataView(
            ataBytes.buffer,
            ataBytes.byteOffset,
            ataBytes.byteLength
          );
          setVaultUsdcBalance(ataView.getBigUint64(64, true));
        } else {
          setVaultUsdcBalance(0n);
        }

        if (targetSession) {
          const sessInfo = secondaryInfos[1];
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
    },
    [ownerKeypair, agentKeypair, connection, activeSessionAddress]
  );

  useEffect(() => {
    void refreshOnChainState();
  }, [refreshOnChainState]);

  useEffect(() => {
    if (busyAction !== null) return;
    const poll = window.setInterval(() => {
      void refreshOnChainState();
    }, 15000);
    return () => window.clearInterval(poll);
  }, [refreshOnChainState, busyAction]);

  const handleCopy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedLabel(label);
    window.setTimeout(() => setCopiedLabel(null), 1600);
  };

  const handleResetSession = () => {
    window.localStorage.removeItem(LS_ACTIVE_SESSION_KEY);
    setActiveSessionAddress(null);
    setSessionState(null);
    setSessionReaped(false);
    setLastRedeemed(null);
    setCompletedSteps({});
    appendTrace({
      title: "Mission Control Reset — Ready for New Session",
      badgeLabel: "SESSION RESET",
      tone: "warn",
      deltaSummary: "0.00 USDC",
      mintSummary: vaultState ? shortKey(vaultState.mint.toBase58()) : "—",
      receiptSummary: "Cleared",
      rawJson: JSON.stringify(
        {
          note: "Click Step 1 to open a fresh bounded Session on your existing Vault (or rotate ephemeral keys to create a brand-new Vault).",
        },
        null,
        2
      ),
    });
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
    setOwnerSol(0);
    setAgentSol(0);
    setVaultState(null);
    setVaultUsdcBalance(0n);
    setSessionState(null);
    setActiveSessionAddress(null);
    setSessionReaped(false);
    setVerifiedMint(null);
    setVerifiedMintMode(null);
    setLastRedeemed(null);
    setCompletedSteps({});
    appendTrace({
      title: "Rotated Ephemeral Browser Keypairs",
      badgeLabel: "NEW KEYS",
      tone: "warn",
      deltaSummary: "0.00 SOL",
      mintSummary: "—",
      receiptSummary: "—",
      rawJson: JSON.stringify(
        {
          newOwner: newOwner.publicKey.toBase58(),
          newAgent: newAgent.publicKey.toBase58(),
        },
        null,
        2
      ),
    });
  };

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
          void fetchServerStatus();
          appendTrace({
            title: faucetBody.funded
              ? `Server Faucet Drip Confirmed (${roleLabel})`
              : `Server Faucet Balance Check (${roleLabel})`,
            badgeLabel: faucetBody.funded
              ? `+${faucetBody.amountSol} SOL`
              : "SUFFICIENT SOL",
            tone: "ok",
            deltaSummary: faucetBody.funded
              ? `+${faucetBody.amountSol} SOL`
              : "0.00 SOL (skipped)",
            mintSummary: "Native SOL",
            receiptSummary: faucetBody.storeMode ?? "atomic_cooldown",
            txSig: faucetBody.txSignature,
            rawJson: JSON.stringify(faucetBody, null, 2),
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
        appendTrace({
          title: `Devnet RPC Airdrop Confirmed (${roleLabel})`,
          badgeLabel: "+0.50 SOL",
          tone: "ok",
          deltaSummary: "+0.50 SOL",
          mintSummary: "Native SOL",
          receiptSummary: "—",
          txSig: sig,
          rawJson: JSON.stringify(
            { recipient: pubkey.toBase58(), amountSol: 0.5 },
            null,
            2
          ),
        });
        return { ok: true, txSig: sig };
      } catch (err: unknown) {
        setFaucetThrottled(true);
        const msg = err instanceof Error ? err.message : String(err);
        appendTrace({
          title: `Manual Devnet Faucet Required (${roleLabel})`,
          badgeLabel: "HTTP 503 / 429",
          tone: "warn",
          deltaSummary: "0.00 SOL",
          mintSummary: "—",
          receiptSummary: "Fallback: faucet.solana.com",
          rawJson: JSON.stringify(
            {
              recipient: pubkey.toBase58(),
              detail: msg,
              fallbackUrl: "https://faucet.solana.com",
            },
            null,
            2
          ),
        });
        return { ok: false };
      }
    },
    [appendTrace, connection, fetchServerStatus]
  );

  const handleManualFund = async (target: "owner" | "agent") => {
    if (!ownerKeypair || !agentKeypair) return;
    const pubkey =
      target === "owner" ? ownerKeypair.publicKey : agentKeypair.publicKey;
    setBusyAction(`fund-${target}`);
    try {
      await fundWalletWithFallback(pubkey, target.toUpperCase());
      await refreshOnChainState();
    } finally {
      setBusyAction(null);
    }
  };

  // STEP 1: Setup Demo Vault & Session (< 0.04 SOL total including Agent stipend)
  const handleStep1Setup = async () => {
    if (!ownerKeypair || !agentKeypair) return;
    setBusyAction("step-1");
    try {
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
            `Owner wallet (${ownerKeypair.publicKey.toBase58()}) needs >= 0.04 Devnet SOL. Copy the Owner pubkey above and fund via https://faucet.solana.com.`
          );
        }
      }

      const preSetupOwnerLamports = await connection.getBalance(
        ownerKeypair.publicKey,
        "confirmed"
      );
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
          idleTimeoutSecs: 120n, // 120s idle timeout
        })
      );
      const setupTxSig = await signAndConfirmBrowserTx(
        connection,
        sessionTx,
        ownerKeypair
      );

      const postSetupOwnerLamports = await connection.getBalance(
        ownerKeypair.publicKey,
        "confirmed"
      );
      const setupSolSpent =
        (preSetupOwnerLamports - postSetupOwnerLamports) / LAMPORTS_PER_SOL;

      window.localStorage.setItem(
        LS_ACTIVE_SESSION_KEY,
        sessionPda.toBase58()
      );
      setActiveSessionAddress(sessionPda);
      setSessionReaped(false);
      setLastRedeemed(null);
      await refreshOnChainState(sessionPda);
      setCompletedSteps({ 1: true });

      appendTrace({
        title: "Step 1 · Demo Vault & Bounded Session Initialized",
        badgeLabel: "ON-CHAIN READY",
        tone: "ok",
        deltaSummary: `+10.00 MockUSDC minted (${setupSolSpent.toFixed(4)} SOL setup)`,
        mintSummary: `${shortKey(mintPubkey.toBase58())} (Sandbox MockUSDC)`,
        receiptSummary: `Session #${nextNonce.toString()} Active`,
        txSig: setupTxSig,
        rawJson: JSON.stringify(
          {
            vaultPda: vaultPda.toBase58(),
            sessionPda: sessionPda.toBase58(),
            mockUsdcMint: mintPubkey.toBase58(),
            ownerSolUsedForSetupAndStipend: Number(setupSolSpent.toFixed(6)),
            policy: {
              maxPerTxUsdc: "0.50",
              bucketCapUsdc: "1.50",
              windowSecs: 30,
              lifetimeCapUsdc: "5.00",
              idleTimeoutSecs: 120,
            },
          },
          null,
          2
        ),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTrace({
        title: "Step 1 · Setup Demo Vault & Session Failed",
        badgeLabel: "SETUP ERROR",
        tone: "trip",
        deltaSummary: "0.00 USDC",
        mintSummary: "—",
        receiptSummary: "—",
        rawJson: JSON.stringify({ error: msg }, null, 2),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // STEP 2: Normal x402 Payment (402 -> execute_agent_spend -> Vault+Receipt Verified -> 200 OK)
  const handleStep2NormalPay = async () => {
    if (!agentKeypair || !vaultState || !activeSessionAddress) return;
    setBusyAction("step-2");
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
      if (challenge.mint !== mintStr) {
        throw new Error(
          body402.reason ||
            `Server strictly enforces EXPECTED_MINT ${challenge.mint}.`
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

      await refreshOnChainState();

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
          receiptPda: receiptPda.toBase58(),
        });
        markStepDone(2);
      }

      appendTrace({
        title: "Step 2 · Normal x402 Payment Settled & Receipt Verified",
        badgeLabel: `HTTP ${res200.status} OK`,
        tone: res200.status === 200 ? "ok" : "trip",
        deltaSummary: "-0.25 MockUSDC (Vault -> Merchant)",
        mintSummary: `${shortKey(mintStr)} (${body200.verificationProof?.mintVerificationMode ?? "verified"})`,
        receiptSummary: `${shortKey(receiptPda.toBase58())} Verified`,
        txSig,
        rawJson: JSON.stringify(
          {
            step1_http402Challenge: body402.challenge,
            step2_http200Verification: body200,
          },
          null,
          2
        ),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTrace({
        title: "Step 2 · Normal x402 Payment Error",
        badgeLabel: "PAYMENT ERROR",
        tone: "trip",
        deltaSummary: "0.00 USDC",
        mintSummary: "—",
        receiptSummary: "—",
        txSig: (err as { txSig?: string })?.txSig,
        rawJson: JSON.stringify({ error: msg }, null, 2),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // STEP 3: Replay Same Receipt (Single-use HTTP 402 Rejection)
  const handleStep3Replay = async () => {
    if (!lastRedeemed) return;
    setBusyAction("step-3");
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
      if (replayRes.status === 402) {
        markStepDone(3);
      }

      const isUpstash = replayBody.replayStore === "upstash_redis";
      appendTrace({
        title: isUpstash
          ? "Step 3 · Single-Use Receipt Replay Blocked (Upstash Atomic)"
          : "Step 3 · Single-Use Receipt Replay Blocked",
        badgeLabel: `HTTP ${replayRes.status} REJECTED`,
        tone: replayRes.status === 402 ? "ok" : "trip",
        deltaSummary: "0.00 USDC (No new tx)",
        mintSummary: shortKey(lastRedeemed.mint),
        receiptSummary: `${shortKey(lastRedeemed.receiptPda)} · ${
          isUpstash ? "Upstash Atomic Lock" : "Already Redeemed"
        }`,
        txSig: lastRedeemed.txSig,
        rawJson: JSON.stringify(replayBody, null, 2),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTrace({
        title: "Step 3 · Replay Test Error",
        badgeLabel: "ERROR",
        tone: "trip",
        deltaSummary: "—",
        mintSummary: "—",
        receiptSummary: "—",
        rawJson: JSON.stringify({ error: msg }, null, 2),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // STEP 4: Inject Prompt-Injection Drain (Ok(()) soft-trip, 0 moved, no Receipt PDA, HTTP 402)
  const handleStep4Drain = async () => {
    if (!agentKeypair || !vaultState || !activeSessionAddress) return;
    setBusyAction("step-4");
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
      markStepDone(4);

      appendTrace({
        title:
          "Step 4 · Prompt-Injection Drain Soft-Tripped Circuit Breaker (0 Moved)",
        badgeLabel: `TRIPPED · HTTP ${verifyAttempt.status}`,
        tone: "trip",
        deltaSummary: `0.00 MockUSDC moved (Vault held ${formatUsdc(vaultBefore)})`,
        mintSummary: shortKey(mintStr),
        receiptSummary: "NONE (Unallocated on trip)",
        txSig,
        rawJson: JSON.stringify(
          {
            attemptedDrainUsdc: formatUsdc(X402_DRAIN_AMOUNT),
            onChainOutcome:
              "Ok(()) committed SessionStatus::Tripped (ExceedsPerTxMax), 0 tokens transferred, 0 Receipt allocated",
            x402VerifierResponse: verifyBody,
          },
          null,
          2
        ),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTrace({
        title: "Step 4 · Drain Simulation Error",
        badgeLabel: "ERROR",
        tone: "trip",
        deltaSummary: "0.00 USDC",
        mintSummary: "—",
        receiptSummary: "—",
        txSig: (err as { txSig?: string })?.txSig,
        rawJson: JSON.stringify({ error: msg }, null, 2),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // STEP 5: Salami Retry After Trip (Hard-reverts Custom(6010) / SessionNotActive)
  const handleStep5Salami = async () => {
    if (!agentKeypair || !vaultState || !activeSessionAddress) return;
    setBusyAction("step-5");
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
          amount: X402_SALAMI_AMOUNT,
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

      appendTrace({
        title: "Step 5 · Unexpected: Session Was Still Active",
        badgeLabel: "WARN",
        tone: "warn",
        deltaSummary: "-0.0001 USDC",
        mintSummary: shortKey(mintStr),
        receiptSummary: "—",
        rawJson: JSON.stringify(
          { warning: "Run Step 4 first to trip the Session." },
          null,
          2
        ),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const txSig = (err as { txSig?: string })?.txSig;
      await refreshOnChainState();
      markStepDone(5);
      appendTrace({
        title:
          "Step 5 · Salami Retry Hard-Reverted On-Chain (Custom(6010) / SessionNotActive)",
        badgeLabel: "REVERTED 0x177a",
        tone: "ok",
        deltaSummary: "0.00 MockUSDC moved (Hard Revert)",
        mintSummary: vaultState ? shortKey(vaultState.mint.toBase58()) : "—",
        receiptSummary: "Blocked at terminal status gate",
        txSig,
        rawJson: JSON.stringify(
          {
            attemptedSalamiAmountBaseUnits: X402_SALAMI_AMOUNT.toString(),
            terminalInvariant:
              "Zero recovery path once SessionStatus != Active",
            onChainError: msg,
          },
          null,
          2
        ),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // STEP 6: Permissionless Reap Idle / Tripped Session
  const handleStep6Reap = async () => {
    if (!agentKeypair || !ownerKeypair || !vaultState || !activeSessionAddress)
      return;
    setBusyAction("step-6");
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
      markStepDone(6);
      appendTrace({
        title:
          "Step 6 · Permissionless Reap Closed Session & Returned Rent to Owner",
        badgeLabel: `+${reclaimedSol.toFixed(5)} SOL`,
        tone: "ok",
        deltaSummary: `+${reclaimedSol.toFixed(6)} SOL to Vault Owner`,
        mintSummary: shortKey(vaultState.mint.toBase58()),
        receiptSummary: `Session ${shortKey(activeSessionAddress.toBase58())} Closed`,
        txSig,
        rawJson: JSON.stringify(
          {
            closedSessionPda: activeSessionAddress.toBase58(),
            permissionlessCaller: agentKeypair.publicKey.toBase58(),
            enforcedRentRecipient: ownerKeypair.publicKey.toBase58(),
            reclaimedSol: Number(reclaimedSol.toFixed(6)),
          },
          null,
          2
        ),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTrace({
        title: "Step 6 · Permissionless Reap Rejected (Session Still Active)",
        badgeLabel: "STILL ACTIVE",
        tone: "warn",
        deltaSummary: "0.00 SOL",
        mintSummary: "—",
        receiptSummary: "Trip in Step 4 or wait past idle timeout",
        txSig: (err as { txSig?: string })?.txSig,
        rawJson: JSON.stringify({ error: msg }, null, 2),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const availableBucket = useMemo(() => {
    if (!sessionState || nowSec === 0n) return sessionState?.bucketTokens ?? 0n;
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
    if (!sessionState || nowSec === 0n) return 0n;
    const diff = nowSec - sessionState.lastActiveTs;
    return diff > 0n ? diff : 0n;
  }, [sessionState, nowSec]);

  const recommendedStep = useMemo(() => {
    if (!vaultState || !activeSessionAddress || sessionReaped) return 1;
    if (!completedSteps[2] && sessionState?.status === "Active") return 2;
    if (lastRedeemed && !completedSteps[3]) return 3;
    if (sessionState?.status === "Active") return 4;
    if (sessionState?.status === "Tripped" && !completedSteps[5]) return 5;
    if (sessionState && !sessionReaped) return 6;
    return 1;
  }, [
    vaultState,
    activeSessionAddress,
    sessionReaped,
    completedSteps,
    sessionState,
    lastRedeemed,
  ]);

  const hasLiveSession = Boolean(
    vaultState && activeSessionAddress && !sessionReaped
  );

  return (
    <main className="console-shell">
      <header className="hero-header">
        <div className="hero-top-row">
          <div className="brand-heading">
            <h1>Leash — Solana x402 Circuit Breaker</h1>
            <p className="brand-pitch">
              <strong>Non-custodial AI agent spending control plane:</strong>{" "}
              policy violations commit an irreversible on-chain{" "}
              <code>SessionStatus::Tripped</code> state with{" "}
              <strong>0 tokens moved</strong>, while canonical{" "}
              <code>Receipt</code> PDAs + <code>Vault.mint</code> binding close
              the non-reverting HTTP <code>402</code> verification trap.
            </p>
          </div>

          <div className="rpc-box" id="devnet-rpc-pill">
            <span className="rpc-label">DEVNET RPC</span>
            <span id="rpc-host-value" className="rpc-host mono">
              {formatRpcHost(rpcUrl)}
            </span>
          </div>
        </div>

        <div className="status-strip" aria-label="Live System Diagnostics">
          <span className="status-pill mono" id="pill-program-id">
            <span className="dot dot-ok" />
            Program:{" "}
            <a
              href={explorerAddressUrl(LEASH_PROGRAM_ID.toBase58())}
              target="_blank"
              rel="noreferrer"
            >
              {shortKey(LEASH_PROGRAM_ID.toBase58())} ↗
            </a>
          </span>

          <span className="status-pill mono" id="pill-devnet-rpc">
            <span className="dot dot-ok" />
            Devnet Live (
            {serverStatus?.rpcMode === "custom_rpc"
              ? "Custom RPC"
              : "Public RPC"}
            )
          </span>

          <span className="status-pill mono" id="pill-faucet-status">
            <span
              className={`dot ${
                serverStatus?.faucet.configured ? "dot-ok" : "dot-warn"
              }`}
            />
            {serverStatus?.faucet.configured
              ? `Faucet Ready${
                  serverStatus.faucet.balanceSol !== undefined
                    ? ` · ${serverStatus.faucet.balanceSol.toFixed(2)} SOL`
                    : ""
                }`
              : "Manual Faucet"}
          </span>

          <span className="status-pill mono" id="pill-replay-store">
            <span
              className={`dot ${
                serverStatus?.replayStore === "upstash_redis"
                  ? "dot-ok"
                  : "dot-cyan"
              }`}
            />
            Replay:{" "}
            {serverStatus?.replayStore === "upstash_redis"
              ? "Upstash Atomic"
              : "In-Memory"}
          </span>

          <span className="status-pill mono" id="pill-mint-policy">
            <span className={`dot ${serverStatus ? "dot-ok" : "dot-warn"}`} />
            {serverStatus?.mintPolicy.mode === "strict_usdc"
              ? "Strict Devnet USDC"
              : "Sandbox MockUSDC"}
          </span>
        </div>

        <div className="mock-disclosure">
          <strong>Mint Policy Disclosure:</strong> This Judge Sandbox mints
          disposable 6-decimal <code>MockUSDC</code> per browser Vault so judges
          can run adversarial drains instantly without external token faucets.
          Production deployments set{" "}
          <code>ALLOW_SANDBOX_MOCK_MINT=false</code> to strictly enforce
          canonical USDC (
          <code>{DEVNET_USDC_MINT.toBase58().slice(0, 8)}...</code>) on{" "}
          <code>Vault.mint</code>.
        </div>
      </header>

      <section className="wallets-bar" aria-label="Ephemeral Browser Keypairs">
        <article className="card">
          <div className="wallet-top">
            <span className="wallet-label">
              Browser Vault Owner (localStorage)
            </span>
            <span className="wallet-sol mono">{ownerSol.toFixed(4)} SOL</span>
          </div>
          <div className="wallet-addr mono">
            {ownerKeypair ? ownerKeypair.publicKey.toBase58() : "Initializing..."}
          </div>
          <div className="wallet-btn-row">
            <button
              id="btn-fund-owner"
              type="button"
              className="btn btn-accent"
              disabled={!ownerKeypair || busyAction !== null}
              onClick={() => handleManualFund("owner")}
            >
              {busyAction === "fund-owner" ? "Funding..." : "Drip 0.05 SOL"}
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
        </article>

        <article className="card">
          <div className="wallet-top">
            <span className="wallet-label">
              Browser Agent Signer (Pays Tx + Receipt Rent)
            </span>
            <span className="wallet-sol mono">{agentSol.toFixed(4)} SOL</span>
          </div>
          <div className="wallet-addr mono">
            {agentKeypair ? agentKeypair.publicKey.toBase58() : "Initializing..."}
          </div>
          <div className="wallet-btn-row">
            <button
              id="btn-fund-agent"
              type="button"
              className="btn"
              disabled={!agentKeypair || busyAction !== null}
              onClick={() => handleManualFund("agent")}
            >
              {busyAction === "fund-agent" ? "Funding..." : "Drip Agent SOL"}
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
          </div>
        </article>

        <article className="card session-controls-card">
          <div>
            <div className="wallet-label">Sandbox Controls</div>
            <div
              style={{
                fontSize: "0.77rem",
                color: "var(--ink-secondary)",
                marginTop: "4px",
              }}
            >
              Re-open a clean Session or rotate browser wallets anytime.
            </div>
          </div>
          <div className="wallet-btn-row">
            <button
              id="btn-reset-session"
              type="button"
              className="btn"
              disabled={busyAction !== null}
              onClick={handleResetSession}
            >
              Reset / New Session
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

      {faucetThrottled && (
        <div className="faucet-fallback-banner">
          Public Devnet RPC throttled airdrop. Click{" "}
          <strong>Copy Pubkey</strong> on Browser Vault Owner above and request
          SOL at{" "}
          <a
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
          >
            faucet.solana.com
          </a>
          . Step 1 fits cleanly under <code>0.04 SOL</code> including the Agent
          stipend.
        </div>
      )}

      <div className="mission-grid">
        <div className="left-column">
          <section className="card" aria-labelledby="mission-heading">
            <div className="card-header">
              <h2 id="mission-heading">Guided 6-Step Adversarial Verification</h2>
              <button
                id="btn-refresh-state"
                type="button"
                className="btn"
                onClick={() => {
                  void refreshOnChainState();
                  void fetchServerStatus();
                }}
              >
                Refresh
              </button>
            </div>

            <div className="steps-stack">
              <button
                id="btn-step-1-setup"
                type="button"
                className={`step-btn ${
                  recommendedStep === 1 ? "step-btn-next" : ""
                }`}
                disabled={!ownerKeypair || busyAction !== null}
                onClick={handleStep1Setup}
              >
                <span
                  className={`step-num mono ${
                    completedSteps[1] ? "step-num-done" : ""
                  }`}
                >
                  {completedSteps[1] ? "✓" : "1"}
                </span>
                <span className="step-content">
                  <span className="step-title-row">
                    <span>Setup Demo Vault &amp; Session</span>
                    <span
                      className={`step-tag mono ${
                        recommendedStep === 1
                          ? "step-tag-next"
                          : completedSteps[1]
                          ? "step-tag-done"
                          : "step-tag-idle"
                      }`}
                    >
                      {busyAction === "step-1"
                        ? "RUNNING..."
                        : recommendedStep === 1
                        ? "NEXT"
                        : completedSteps[1]
                        ? "DONE"
                        : "< 0.04 SOL"}
                    </span>
                  </span>
                  <span className="step-desc">
                    Auto-drips 0.05 SOL via /api/faucet, mints 10 MockUSDC to
                    Vault PDA, and opens bounded Session (0.50 max/tx).
                  </span>
                </span>
              </button>

              <button
                id="btn-step-2-pay"
                type="button"
                className={`step-btn ${
                  recommendedStep === 2 ? "step-btn-next" : ""
                }`}
                disabled={!hasLiveSession || busyAction !== null}
                onClick={handleStep2NormalPay}
              >
                <span
                  className={`step-num mono ${
                    completedSteps[2] ? "step-num-done" : ""
                  }`}
                >
                  {completedSteps[2] ? "✓" : "2"}
                </span>
                <span className="step-content">
                  <span className="step-title-row">
                    <span>Normal x402 Payment (402 -&gt; 200 OK)</span>
                    <span
                      className={`step-tag mono ${
                        recommendedStep === 2
                          ? "step-tag-next"
                          : completedSteps[2]
                          ? "step-tag-done"
                          : "step-tag-idle"
                      }`}
                    >
                      {busyAction === "step-2"
                        ? "SETTLING..."
                        : recommendedStep === 2
                        ? "NEXT"
                        : completedSteps[2]
                        ? "DONE"
                        : "0.25 USDC"}
                    </span>
                  </span>
                  <span className="step-desc">
                    Settles 0.25 USDC via execute_agent_spend; server verifies
                    Receipt PDA + Vault.mint before returning 200 OK.
                  </span>
                </span>
              </button>

              <button
                id="btn-step-3-replay"
                type="button"
                className={`step-btn ${
                  recommendedStep === 3 ? "step-btn-next" : ""
                }`}
                disabled={!lastRedeemed || busyAction !== null}
                onClick={handleStep3Replay}
              >
                <span
                  className={`step-num mono ${
                    completedSteps[3] ? "step-num-done" : ""
                  }`}
                >
                  {completedSteps[3] ? "✓" : "3"}
                </span>
                <span className="step-content">
                  <span className="step-title-row">
                    <span>Replay Same Receipt (Single-Use Guard)</span>
                    <span
                      className={`step-tag mono ${
                        recommendedStep === 3
                          ? "step-tag-next"
                          : completedSteps[3]
                          ? "step-tag-done"
                          : "step-tag-idle"
                      }`}
                    >
                      {busyAction === "step-3"
                        ? "CHECKING..."
                        : recommendedStep === 3
                        ? "NEXT"
                        : completedSteps[3]
                        ? "DONE"
                        : "MUST 402"}
                    </span>
                  </span>
                  <span className="step-desc">
                    Re-sends the redeemed Receipt headers; atomic SET NX EX
                    replay lock rejects reuse with HTTP 402.
                  </span>
                </span>
              </button>

              <button
                id="btn-step-4-drain"
                type="button"
                className={`step-btn step-btn-danger ${
                  recommendedStep === 4 ? "step-btn-next" : ""
                }`}
                disabled={!hasLiveSession || busyAction !== null}
                onClick={handleStep4Drain}
              >
                <span
                  className={`step-num mono ${
                    completedSteps[4] ? "step-num-done" : ""
                  }`}
                >
                  {completedSteps[4] ? "✓" : "4"}
                </span>
                <span className="step-content">
                  <span className="step-title-row">
                    <span>Inject Prompt-Injection Drain (Soft-Trip)</span>
                    <span
                      className={`step-tag mono ${
                        recommendedStep === 4
                          ? "step-tag-next"
                          : completedSteps[4]
                          ? "step-tag-done"
                          : "step-tag-idle"
                      }`}
                    >
                      {busyAction === "step-4"
                        ? "TRIPPING..."
                        : recommendedStep === 4
                        ? "NEXT"
                        : completedSteps[4]
                        ? "DONE"
                        : "5.00 USDC"}
                    </span>
                  </span>
                  <span className="step-desc">
                    Attempts 5.00 USDC (&gt; max_per_tx). Commits Tripped via
                    Ok(()), moves 0 tokens, allocates no Receipt, rejected 402.
                  </span>
                </span>
              </button>

              <button
                id="btn-step-5-salami"
                type="button"
                className={`step-btn ${
                  recommendedStep === 5 ? "step-btn-next" : ""
                }`}
                disabled={!hasLiveSession || busyAction !== null}
                onClick={handleStep5Salami}
              >
                <span
                  className={`step-num mono ${
                    completedSteps[5] ? "step-num-done" : ""
                  }`}
                >
                  {completedSteps[5] ? "✓" : "5"}
                </span>
                <span className="step-content">
                  <span className="step-title-row">
                    <span>Salami Retry After Trip (Hard-Reverts)</span>
                    <span
                      className={`step-tag mono ${
                        recommendedStep === 5
                          ? "step-tag-next"
                          : completedSteps[5]
                          ? "step-tag-done"
                          : "step-tag-idle"
                      }`}
                    >
                      {busyAction === "step-5"
                        ? "TESTING..."
                        : recommendedStep === 5
                        ? "NEXT"
                        : completedSteps[5]
                        ? "DONE"
                        : "0.0001 USDC"}
                    </span>
                  </span>
                  <span className="step-desc">
                    Attempts tiny 100-unit follow-up spend on Tripped Session;
                    hard-reverts on-chain with Custom(6010) / SessionNotActive.
                  </span>
                </span>
              </button>

              <button
                id="btn-step-6-reap"
                type="button"
                className={`step-btn ${
                  recommendedStep === 6 ? "step-btn-next" : ""
                }`}
                disabled={!hasLiveSession || busyAction !== null}
                onClick={handleStep6Reap}
              >
                <span
                  className={`step-num mono ${
                    completedSteps[6] ? "step-num-done" : ""
                  }`}
                >
                  {completedSteps[6] ? "✓" : "6"}
                </span>
                <span className="step-content">
                  <span className="step-title-row">
                    <span>Permissionless Reap Idle / Tripped Session</span>
                    <span
                      className={`step-tag mono ${
                        recommendedStep === 6
                          ? "step-tag-next"
                          : completedSteps[6]
                          ? "step-tag-done"
                          : "step-tag-idle"
                      }`}
                    >
                      {busyAction === "step-6"
                        ? "REAPING..."
                        : recommendedStep === 6
                        ? "NEXT"
                        : completedSteps[6]
                        ? "DONE"
                        : "RECLAIM SOL"}
                    </span>
                  </span>
                  <span className="step-desc">
                    Non-owner caller closes Tripped Session PDA and returns 100%
                    of rent lamports directly to vault.owner.
                  </span>
                </span>
              </button>
            </div>
          </section>
        </div>

        <div className="right-column">
          <section className="card" aria-labelledby="telemetry-heading">
            <div className="card-header">
              <h2 id="telemetry-heading">Live On-Chain Vault &amp; Session State</h2>
              {sessionState ? (
                <span
                  id="session-status-badge"
                  className={`status-badge mono ${
                    sessionState.status === "Active"
                      ? "badge-active"
                      : "badge-tripped"
                  }`}
                >
                  {sessionState.status === "Tripped"
                    ? `TRIPPED · ${sessionState.tripReason}`
                    : sessionState.status.toUpperCase()}
                </span>
              ) : sessionReaped ? (
                <span
                  id="session-status-badge"
                  className="status-badge mono badge-neutral"
                >
                  REAPED (RENT RETURNED)
                </span>
              ) : (
                <span
                  id="session-status-badge"
                  className="status-badge mono badge-neutral"
                >
                  UNINITIALIZED
                </span>
              )}
            </div>

            {sessionState && (
              <div className="meters-wrap">
                <div>
                  <div className="meter-head">
                    <span>Leaky-Bucket Rate Limit (30s linear refill)</span>
                    <span className="mono">
                      {formatUsdc(availableBucket)} /{" "}
                      {formatUsdc(sessionState.bucketCap)} USDC
                    </span>
                  </div>
                  <div className="meter-track">
                    <div
                      className={`meter-bar ${
                        sessionState.status !== "Active"
                          ? "meter-bar-tripped"
                          : ""
                      }`}
                      style={{ width: `${bucketPct}%` }}
                    />
                  </div>
                </div>

                <div>
                  <div className="meter-head">
                    <span>Lifetime Session Cap</span>
                    <span className="mono">
                      {formatUsdc(sessionState.lifetimeSpent)} /{" "}
                      {formatUsdc(sessionState.lifetimeCap)} USDC
                    </span>
                  </div>
                  <div className="meter-track">
                    <div
                      className="meter-bar"
                      style={{ width: `${lifetimePct}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="state-grid">
              <div className="state-k">Vault Balance</div>
              <div className="state-v mono" id="val-vault-balance">
                {vaultState ? `${formatUsdc(vaultUsdcBalance)} MockUSDC` : "—"}
              </div>

              <div className="state-k">Trip Reason</div>
              <div className="state-v mono" id="val-trip-reason">
                {sessionState ? sessionState.tripReason : "—"}
              </div>

              <div className="state-k">Max Per Tx</div>
              <div className="state-v mono">
                {sessionState
                  ? `${formatUsdc(sessionState.maxPerTx)} USDC`
                  : "—"}
              </div>

              <div className="state-k">Idle Window</div>
              <div className="state-v mono">
                {sessionState
                  ? `${idleSecondsElapsed.toString()}s / ${sessionState.idleTimeoutSecs.toString()}s`
                  : "—"}
              </div>

              <div className="state-k">Verified Mint</div>
              <div className="state-v mono">
                {verifiedMint
                  ? `${shortKey(verifiedMint)} (${verifiedMintMode})`
                  : vaultState
                  ? `${shortKey(vaultState.mint.toBase58())} (Vault.mint)`
                  : "—"}
              </div>

              <div className="state-k">Vault PDA</div>
              <div className="state-v mono">
                {vaultState ? (
                  <a
                    href={explorerAddressUrl(vaultState.address.toBase58())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortKey(vaultState.address.toBase58())} ↗
                  </a>
                ) : (
                  "—"
                )}
              </div>

              <div className="state-k">Session PDA</div>
              <div className="state-v mono">
                {activeSessionAddress ? (
                  <a
                    href={explorerAddressUrl(activeSessionAddress.toBase58())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortKey(activeSessionAddress.toBase58())} ↗
                  </a>
                ) : (
                  "—"
                )}
              </div>

              <div className="state-k">
                Allowlist ({vaultState?.allowlist.length ?? 0}/16)
              </div>
              <div className="state-v">
                <div className="allowlist-pills">
                  {vaultState && vaultState.allowlist.length > 0 ? (
                    vaultState.allowlist.map((pk) => (
                      <span
                        key={pk.toBase58()}
                        className="allowlist-pill mono"
                      >
                        {shortKey(pk.toBase58())}
                      </span>
                    ))
                  ) : (
                    <span className="allowlist-pill mono">
                      x402: {shortKey(X402_MERCHANT_PUBKEY.toBase58())}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section
            className="card trace-panel"
            aria-labelledby="trace-log-heading"
          >
            <div className="card-header">
              <h2 id="trace-log-heading">
                Structured x402 Protocol &amp; On-Chain Trace Log
              </h2>
              <button
                id="btn-clear-logs"
                type="button"
                className="btn"
                onClick={() => setLogs([])}
              >
                Clear Log
              </button>
            </div>

            <div className="trace-list" id="protocol-trace-list">
              {logs.length === 0 ? (
                <div className="trace-empty mono">
                  Ready for live Solana Devnet execution. Click{" "}
                  <strong>1. Setup Demo Vault &amp; Session</strong> on the left
                  to drip Devnet SOL, mint disposable MockUSDC into your
                  canonical Vault PDA, and walk through all 6 adversarial steps.
                </div>
              ) : (
                logs.map((entry) => (
                  <article key={entry.id} className="trace-card">
                    <div className="trace-card-head">
                      <span className="trace-title">{entry.title}</span>
                      <div className="trace-head-right">
                        <span
                          className={`http-pill mono ${
                            entry.tone === "ok"
                              ? "http-pill-ok"
                              : entry.tone === "trip"
                              ? "http-pill-trip"
                              : "http-pill-warn"
                          }`}
                        >
                          {entry.badgeLabel}
                        </span>
                        <span className="trace-time mono">
                          {entry.timestamp}
                        </span>
                      </div>
                    </div>

                    <div className="trace-summary-grid">
                      <div>
                        <div className="trace-metric-label">On-Chain Delta</div>
                        <div className="trace-metric-val mono">
                          {entry.deltaSummary}
                        </div>
                      </div>
                      <div>
                        <div className="trace-metric-label">Verified Mint</div>
                        <div className="trace-metric-val mono">
                          {entry.mintSummary}
                        </div>
                      </div>
                      <div>
                        <div className="trace-metric-label">
                          Receipt / Guard
                        </div>
                        <div className="trace-metric-val mono">
                          {entry.receiptSummary}
                        </div>
                      </div>
                      <div>
                        <div className="trace-metric-label">
                          Solana Devnet Tx
                        </div>
                        <div className="trace-metric-val mono">
                          {entry.txSig ? (
                            <a
                              href={explorerTxUrl(entry.txSig)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shortKey(entry.txSig)} ↗
                            </a>
                          ) : (
                            "HTTP-only (0 gas)"
                          )}
                        </div>
                      </div>
                    </div>

                    <details className="trace-details">
                      <summary className="mono">
                        Inspect Raw HTTP / On-Chain Payload
                      </summary>
                      <pre className="trace-pre mono">{entry.rawJson}</pre>
                    </details>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      <section
        id="architecture-diagram-section"
        className="card arch-section"
        aria-labelledby="arch-heading"
      >
        <div className="card-header">
          <h2 id="arch-heading">
            Why Naive <code>tx.meta.err == null</code> Fails &amp; How Leash
            Closes the Non-Reverting x402 Trap
          </h2>
        </div>
        <p className="arch-caption">
          On Solana, reverting transactions roll back all state changes—so a
          circuit breaker <strong>must</strong> return <code>Ok(())</code> to
          persist <code>SessionStatus::Tripped</code> on-chain. Leash prevents
          false-positive HTTP 200 unlocks by allocating canonical{" "}
          <code>Receipt</code> PDAs only on the passing settlement path and
          binding <code>Vault.mint</code> + atomic <code>SET NX EX</code>{" "}
          single-use locks.
        </p>

        <div className="arch-svg-wrap">
          <svg
            className="arch-svg"
            viewBox="0 0 1120 270"
            role="img"
            aria-label="Architecture comparison between naive tx.meta.err x402 verification and Leash Receipt PDA + Vault.mint + Atomic Replay verification"
          >
            <rect
              x="8"
              y="10"
              width="1104"
              height="114"
              rx="8"
              fill="#191113"
              stroke="#5c2629"
              strokeWidth="1.2"
            />
            <text
              x="26"
              y="34"
              fill="#f87171"
              fontSize="12.5"
              fontWeight="700"
              fontFamily="monospace"
            >
              VULNERABLE: NAIVE x402 VERIFIER (CHECKS tx.meta.err == null ONLY)
            </text>

            <rect
              x="26"
              y="48"
              width="210"
              height="60"
              rx="6"
              fill="#11161f"
              stroke="#334155"
            />
            <text x="38" y="72" fill="#e2e8f0" fontSize="12" fontWeight="600">
              Prompt-Injected Agent
            </text>
            <text x="38" y="92" fill="#94a3b8" fontSize="11" fontFamily="monospace">
              spend(5.00 &gt; 0.50 max)
            </text>

            <line
              x1="236"
              y1="78"
              x2="282"
              y2="78"
              stroke="#f87171"
              strokeWidth="1.8"
            />
            <polygon points="282,78 274,73 274,83" fill="#f87171" />

            <rect
              x="286"
              y="48"
              width="275"
              height="60"
              rx="6"
              fill="#11161f"
              stroke="#5c2629"
            />
            <text x="298" y="72" fill="#fca5a5" fontSize="12" fontWeight="600">
              Soft-Trip Commit: Ok(())
            </text>
            <text x="298" y="92" fill="#94a3b8" fontSize="11" fontFamily="monospace">
              meta.err = null | 0 USDC moved
            </text>

            <line
              x1="561"
              y1="78"
              x2="607"
              y2="78"
              stroke="#f87171"
              strokeWidth="1.8"
            />
            <polygon points="607,78 599,73 599,83" fill="#f87171" />

            <rect
              x="611"
              y="48"
              width="245"
              height="60"
              rx="6"
              fill="#11161f"
              stroke="#5c2629"
            />
            <text x="623" y="72" fill="#e2e8f0" fontSize="12" fontWeight="600">
              Naive Resource Server
            </text>
            <text x="623" y="92" fill="#94a3b8" fontSize="11" fontFamily="monospace">
              if (tx.meta.err == null)
            </text>

            <line
              x1="856"
              y1="78"
              x2="902"
              y2="78"
              stroke="#f87171"
              strokeWidth="1.8"
            />
            <polygon points="902,78 894,73 894,83" fill="#f87171" />

            <rect
              x="906"
              y="48"
              width="190"
              height="60"
              rx="6"
              fill="#3b1216"
              stroke="#f87171"
            />
            <text x="920" y="73" fill="#fecaca" fontSize="12" fontWeight="700">
              FALSE 200 OK BYPASS
            </text>
            <text x="920" y="92" fill="#fca5a5" fontSize="11" fontFamily="monospace">
              Unpaid data leaked!
            </text>

            <rect
              x="8"
              y="144"
              width="1104"
              height="116"
              rx="8"
              fill="#0d1b18"
              stroke="#1f5c4d"
              strokeWidth="1.2"
            />
            <text
              x="26"
              y="168"
              fill="#34d399"
              fontSize="12.5"
              fontWeight="700"
              fontFamily="monospace"
            >
              LEASH HARDENED x402: RECEIPT PDA + VAULT.MINT BINDING + ATOMIC SET NX EX REPLAY GUARD
            </text>

            <rect
              x="26"
              y="182"
              width="210"
              height="62"
              rx="6"
              fill="#11161f"
              stroke="#334155"
            />
            <text x="38" y="206" fill="#e2e8f0" fontSize="12" fontWeight="600">
              Bounded Session Spend
            </text>
            <text x="38" y="226" fill="#94a3b8" fontSize="11" fontFamily="monospace">
              All 7 policy checks pass
            </text>

            <line
              x1="236"
              y1="213"
              x2="282"
              y2="213"
              stroke="#34d399"
              strokeWidth="1.8"
            />
            <polygon points="282,213 274,208 274,218" fill="#34d399" />

            <rect
              x="286"
              y="182"
              width="275"
              height="62"
              rx="6"
              fill="#11161f"
              stroke="#1f5c4d"
            />
            <text x="298" y="206" fill="#6ee7b7" fontSize="12" fontWeight="600">
              SPL Transfer + Receipt PDA
            </text>
            <text x="298" y="226" fill="#94a3b8" fontSize="11" fontFamily="monospace">
              seeds=[&quot;receipt&quot;,vault,hash]
            </text>

            <line
              x1="561"
              y1="213"
              x2="607"
              y2="213"
              stroke="#34d399"
              strokeWidth="1.8"
            />
            <polygon points="607,213 599,208 599,218" fill="#34d399" />

            <rect
              x="611"
              y="182"
              width="245"
              height="62"
              rx="6"
              fill="#11161f"
              stroke="#1f5c4d"
            />
            <text x="623" y="206" fill="#e2e8f0" fontSize="12" fontWeight="600">
              /api/x402/resource Verifier
            </text>
            <text x="623" y="226" fill="#94a3b8" fontSize="11" fontFamily="monospace">
              Vault.mint + Slot + SET NX
            </text>

            <line
              x1="856"
              y1="213"
              x2="902"
              y2="213"
              stroke="#34d399"
              strokeWidth="1.8"
            />
            <polygon points="902,213 894,208 894,218" fill="#34d399" />

            <rect
              x="906"
              y="182"
              width="190"
              height="62"
              rx="6"
              fill="#0f2f26"
              stroke="#34d399"
            />
            <text x="920" y="207" fill="#a7f3d0" fontSize="12" fontWeight="700">
              VERIFIED 200 OK
            </text>
            <text x="920" y="226" fill="#6ee7b7" fontSize="11" fontFamily="monospace">
              Single-use settled!
            </text>
          </svg>
        </div>
      </section>
    </main>
  );
}

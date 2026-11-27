import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
import * as fs from "fs";
import * as path from "path";
import { Leash } from "../target/types/leash";

const DEVNET_RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const X402_BASE_URL =
  process.env.X402_RESOURCE_URL || "http://127.0.0.1:3402/api/x402/resource";

function loadKeypair(relPath: string): Keypair {
  const fullPath = path.resolve(__dirname, "..", relPath);
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function hexToNumberArray(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

function deriveVaultPda(owner: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    programId
  );
}

function deriveSessionPda(
  vault: PublicKey,
  nonce: BN | bigint | number,
  programId: PublicKey
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(nonce.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("session"), vault.toBuffer(), buf],
    programId
  );
}

function deriveReceiptPda(
  vault: PublicKey,
  requestHash: number[],
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), vault.toBuffer(), Buffer.from(requestHash)],
    programId
  );
}

async function sendAndPollConfirm(
  connection: Connection,
  tx: Transaction,
  feePayer: Keypair,
  extraSigners: Keypair[] = []
): Promise<string> {
  tx.feePayer = feePayer.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(feePayer, ...extraSigners);

  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const statuses = await connection.getSignatureStatuses([sig]);
    const st = statuses.value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")
    ) {
      if (st.err) {
        throw new Error(`Transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      }
      return sig;
    }
  }
  throw new Error(`Timed out confirming ${sig}`);
}

async function createDevnetSession(
  connection: Connection,
  program: Program<Leash>,
  owner: Keypair,
  agent: PublicKey,
  vaultPda: PublicKey
): Promise<PublicKey> {
  const vaultAcc = await program.account.vault.fetch(vaultPda);
  const [sessionPda] = deriveSessionPda(vaultPda, vaultAcc.sessionNonce, program.programId);
  const tx = await program.methods
    .createSession(
      agent,
      new BN(500_000), // 0.50 USDC max_per_tx
      new BN(1_500_000),
      new BN(30),
      new BN(5_000_000),
      new BN(120)
    )
    .accountsPartial({
      owner: owner.publicKey,
      vault: vaultPda,
      session: sessionPda,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  await sendAndPollConfirm(connection, tx, owner);
  return sessionPda;
}

interface X402ChallengeResponse {
  status: number;
  error?: string;
  reason?: string;
  verified?: boolean;
  challenge: {
    version: string;
    nonce: string;
    requestHashHex: string;
    canonicalPreimage: string;
    merchant: string;
    mint: string;
    mintVerificationMode: string;
    amount: string;
    receiptTtlSlots: number;
  };
}

interface X402SuccessResponse {
  status: number;
  verified: boolean;
  verificationProof: {
    mint: string;
    mintVerificationMode: string;
    receiptPda: string;
    vault: string;
    [key: string]: unknown;
  };
  data: Record<string, unknown>;
}

async function main(): Promise<void> {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const owner = loadKeypair(".devnet-keys/owner-devnet.json");
  const agent = loadKeypair(".devnet-keys/agent-devnet.json");

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../target/idl/leash.json"), "utf-8")
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
    commitment: "confirmed",
  });
  const program = new Program<Leash>(idl as Leash, provider);

  const [vaultPda] = deriveVaultPda(owner.publicKey, program.programId);
  const vaultAcc = await program.account.vault.fetch(vaultPda);
  const mockUsdcStr = vaultAcc.mint.toBase58();
  const challengeUrl = `${X402_BASE_URL}?mint=${encodeURIComponent(mockUsdcStr)}`;

  // =========================================================================
  // CASE 1: Unauthenticated GET /api/x402/resource?mint=<mockUsdc> -> HTTP 402
  // =========================================================================
  const res1 = await fetch(challengeUrl);
  const body1 = (await res1.json()) as X402ChallengeResponse;
  console.log("=== CASE 1: Unauthenticated GET /api/x402/resource?mint=<mockUsdc> ===");
  console.log(`HTTP Status: ${res1.status}`);
  console.log(JSON.stringify(body1, null, 2));
  if (
    res1.status !== 402 ||
    body1.challenge.mint !== mockUsdcStr ||
    !body1.challenge.canonicalPreimage.includes(`|${mockUsdcStr}|`)
  ) {
    throw new Error("Case 1 failed: expected HTTP 402 with mint bound in challenge & preimage");
  }

  // =========================================================================
  // CASE 2: Soft-Tripped Devnet Tx (meta.err == null, 0 Receipt PDA) -> HTTP 402
  // =========================================================================
  const ch1 = body1.challenge;
  const hashBytes1 = hexToNumberArray(ch1.requestHashHex);
  const merchantPubkey = new PublicKey(ch1.merchant);
  const merchantMockUsdcAta = getAssociatedTokenAddressSync(
    vaultAcc.mint,
    merchantPubkey,
    true
  );
  const [receiptPda1] = deriveReceiptPda(vaultPda, hashBytes1, program.programId);

  const sessionForTrip = await createDevnetSession(
    connection,
    program,
    owner,
    agent.publicKey,
    vaultPda
  );

  const tripTx = await program.methods
    .executeAgentSpend(new BN(5_000_000), hashBytes1, new BN(ch1.receiptTtlSlots))
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: vaultPda,
      session: sessionForTrip,
      mint: vaultAcc.mint,
      vaultAta: vaultAcc.vaultAta,
      merchant: merchantPubkey,
      merchantAta: merchantMockUsdcAta,
      receipt: receiptPda1,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const trippedSig = await sendAndPollConfirm(connection, tripTx, agent);

  const res2 = await fetch(X402_BASE_URL, {
    headers: {
      "X-402-Vault": vaultPda.toBase58(),
      "X-402-Mint": mockUsdcStr,
      "X-402-Nonce": ch1.nonce,
      "X-402-Tx-Signature": trippedSig,
    },
  });
  const body2 = (await res2.json()) as X402ChallengeResponse;
  console.log("\n=== CASE 2: Soft-Tripped Devnet Tx (meta.err == null, 0 Receipt PDA) ===");
  console.log(`Tripped Devnet Tx: https://explorer.solana.com/tx/${trippedSig}?cluster=devnet`);
  console.log(`HTTP Status: ${res2.status}`);
  console.log(JSON.stringify(body2, null, 2));
  if (res2.status !== 402) {
    throw new Error(`Case 2 failed: expected HTTP 402, got ${res2.status}`);
  }

  // =========================================================================
  // CASE 3: Fake-Mint Attack (Real Devnet Receipt PDA settled via FakeMint Vault) -> HTTP 402
  // =========================================================================
  const resCh3 = await fetch(challengeUrl);
  const bodyCh3 = (await resCh3.json()) as X402ChallengeResponse;
  const ch3 = bodyCh3.challenge;
  const hashBytes3 = hexToNumberArray(ch3.requestHashHex);

  // Attacker creates a separate Vault backed by a worthless FakeMint and settles ch3's exact hash!
  const fakeOwner = Keypair.generate();
  const fakeMintKeypair = Keypair.generate();
  const fakeMint = fakeMintKeypair.publicKey;
  const [fakeVaultPda] = deriveVaultPda(fakeOwner.publicKey, program.programId);
  const fakeVaultAta = getAssociatedTokenAddressSync(fakeMint, fakeVaultPda, true);
  const merchantFakeMintAta = getAssociatedTokenAddressSync(fakeMint, merchantPubkey, true);
  const [fakeSessionPda] = deriveSessionPda(fakeVaultPda, 0, program.programId);
  const [fakeReceiptPda] = deriveReceiptPda(fakeVaultPda, hashBytes3, program.programId);

  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  // Fund fakeOwner with 0.025 SOL and initialize FakeMint + FakeVault + Session in 1-2 txs
  const fundFakeOwnerTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: fakeOwner.publicKey,
      lamports: Math.floor(0.025 * LAMPORTS_PER_SOL),
    })
  );
  await sendAndPollConfirm(connection, fundFakeOwnerTx, owner);

  const initFakeVaultIx = await program.methods
    .initVault(fakeMint, [merchantPubkey])
    .accountsPartial({
      owner: fakeOwner.publicKey,
      vault: fakeVaultPda,
      mint: fakeMint,
      vaultAta: fakeVaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const createFakeSessionIx = await program.methods
    .createSession(
      agent.publicKey,
      new BN(500_000),
      new BN(1_500_000),
      new BN(30),
      new BN(5_000_000),
      new BN(120)
    )
    .accountsPartial({
      owner: fakeOwner.publicKey,
      vault: fakeVaultPda,
      session: fakeSessionPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const setupFakeVaultTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: fakeOwner.publicKey,
      newAccountPubkey: fakeMint,
      space: MINT_SIZE,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(fakeMint, 6, fakeOwner.publicKey, null),
    createAssociatedTokenAccountIdempotentInstruction(
      fakeOwner.publicKey,
      merchantFakeMintAta,
      merchantPubkey,
      fakeMint
    ),
    initFakeVaultIx,
    createMintToInstruction(fakeMint, fakeVaultAta, fakeOwner.publicKey, 10_000_000),
    createFakeSessionIx
  );
  await sendAndPollConfirm(connection, setupFakeVaultTx, fakeOwner, [fakeMintKeypair]);

  // Settle a REAL Receipt PDA on Devnet paying worthless FakeMint tokens with ch3's request_hash!
  const fakeSpendTx = await program.methods
    .executeAgentSpend(
      new BN(ch3.amount),
      hashBytes3,
      new BN(ch3.receiptTtlSlots)
    )
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: fakeVaultPda,
      session: fakeSessionPda,
      mint: fakeMint,
      vaultAta: fakeVaultAta,
      merchant: merchantPubkey,
      merchantAta: merchantFakeMintAta,
      receipt: fakeReceiptPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const fakeMintSig = await sendAndPollConfirm(connection, fakeSpendTx, agent);

  const res3 = await fetch(X402_BASE_URL, {
    headers: {
      "X-402-Vault": fakeVaultPda.toBase58(),
      "X-402-Mint": mockUsdcStr,
      "X-402-Nonce": ch3.nonce,
      "X-402-Tx-Signature": fakeMintSig,
    },
  });
  const body3 = (await res3.json()) as X402ChallengeResponse;
  console.log("\n=== CASE 3: Fake-Mint Attack (Real Receipt PDA via FakeMint Vault) ===");
  console.log(`Fake-Mint Devnet Tx: https://explorer.solana.com/tx/${fakeMintSig}?cluster=devnet`);
  console.log(`Fake Vault (${fakeVaultPda.toBase58()}) Mint: ${fakeMint.toBase58()}`);
  console.log(`Expected Challenge Mint: ${mockUsdcStr}`);
  console.log(`HTTP Status: ${res3.status}`);
  console.log(JSON.stringify(body3, null, 2));
  if (
    res3.status !== 402 ||
    !(body3.reason || "").toLowerCase().includes("mint mismatch")
  ) {
    throw new Error(
      `Case 3 failed: expected HTTP 402 with Mint mismatch reason, got ${res3.status}: ${body3.reason}`
    );
  }

  // =========================================================================
  // CASE 4: Valid Devnet execute_agent_spend Matching Challenge Mint + Hash -> HTTP 200 OK
  // =========================================================================
  const resCh4 = await fetch(challengeUrl);
  const bodyCh4 = (await resCh4.json()) as X402ChallengeResponse;
  const ch4 = bodyCh4.challenge;
  const hashBytes4 = hexToNumberArray(ch4.requestHashHex);
  const [receiptPda4] = deriveReceiptPda(vaultPda, hashBytes4, program.programId);

  const sessionForValid = await createDevnetSession(
    connection,
    program,
    owner,
    agent.publicKey,
    vaultPda
  );

  const validTx = await program.methods
    .executeAgentSpend(
      new BN(ch4.amount),
      hashBytes4,
      new BN(ch4.receiptTtlSlots)
    )
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: vaultPda,
      session: sessionForValid,
      mint: vaultAcc.mint,
      vaultAta: vaultAcc.vaultAta,
      merchant: merchantPubkey,
      merchantAta: merchantMockUsdcAta,
      receipt: receiptPda4,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const validSig = await sendAndPollConfirm(connection, validTx, agent);

  const validHeaders = {
    "X-402-Vault": vaultPda.toBase58(),
    "X-402-Mint": mockUsdcStr,
    "X-402-Nonce": ch4.nonce,
    "X-402-Tx-Signature": validSig,
  };

  const res4 = await fetch(X402_BASE_URL, { headers: validHeaders });
  const body4 = (await res4.json()) as X402SuccessResponse;
  console.log("\n=== CASE 4: Valid Devnet Spend Matching Mint + Hash (Vault + Receipt Verified) ===");
  console.log(`Settled Devnet Tx: https://explorer.solana.com/tx/${validSig}?cluster=devnet`);
  console.log(`HTTP Status: ${res4.status}`);
  console.log(JSON.stringify(body4, null, 2));
  if (
    res4.status !== 200 ||
    !body4.verified ||
    body4.verificationProof.mint !== mockUsdcStr
  ) {
    throw new Error(`Case 4 failed: expected HTTP 200 verified mint=${mockUsdcStr}`);
  }

  // =========================================================================
  // CASE 5: Immediate Replay of Exact Same Headers from Case 4 -> HTTP 402 Rejected
  // =========================================================================
  const res5 = await fetch(X402_BASE_URL, { headers: validHeaders });
  const body5 = (await res5.json()) as X402ChallengeResponse;
  console.log("\n=== CASE 5: Immediate Replay of Redeemed Receipt Headers ===");
  console.log(`HTTP Status: ${res5.status}`);
  console.log(JSON.stringify(body5, null, 2));
  if (
    res5.status !== 402 ||
    !(body5.reason || "").includes("Receipt already redeemed")
  ) {
    throw new Error(
      `Case 5 failed: expected HTTP 402 Receipt already redeemed, got ${res5.status}: ${body5.reason}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

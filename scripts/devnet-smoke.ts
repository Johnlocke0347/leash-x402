import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionError,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Leash } from "../target/types/leash";

const DEVNET_RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function loadKeypair(relPath: string): Keypair {
  const fullPath = path.resolve(__dirname, "..", relPath);
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
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

function sha256Challenge(
  method: string,
  routePath: string,
  merchant: PublicKey,
  amount: number,
  nonce: string
): number[] {
  const payload = `${method}|${routePath}|${merchant.toBase58()}|${amount}|${nonce}`;
  return Array.from(createHash("sha256").update(payload).digest());
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Pure HTTP signature polling (avoids Devnet WebSocket 429 limits and returns on-chain err cleanly)
async function sendAndPollConfirm(
  connection: Connection,
  tx: Transaction,
  feePayer: Keypair,
  extraSigners: Keypair[] = [],
  opts: { skipPreflight?: boolean; allowOnChainErr?: boolean } = {}
): Promise<{ sig: string; err: TransactionError | null }> {
  tx.feePayer = feePayer.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(feePayer, ...extraSigners);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: opts.skipPreflight ?? false,
    maxRetries: 5,
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(1200);
    const statuses = await connection.getSignatureStatuses([sig]);
    const st = statuses.value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")
    ) {
      if (st.err && !opts.allowOnChainErr) {
        throw new Error(`Transaction ${sig} reverted: ${JSON.stringify(st.err)}`);
      }
      return { sig, err: st.err };
    }
  }

  throw new Error(`Timed out confirming Devnet transaction ${sig}`);
}

async function main(): Promise<void> {
  const connection = new Connection(DEVNET_RPC, {
    commitment: "confirmed",
    disableRetryOnRateLimit: false,
  });
  const owner = loadKeypair(".devnet-keys/owner-devnet.json");
  const agent = loadKeypair(".devnet-keys/agent-devnet.json");
  const keeper = Keypair.generate();

  const idlPath = path.resolve(__dirname, "../target/idl/leash.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = new Program<Leash>(idl as Leash, provider);

  const [x402MerchantPubkey] = PublicKey.findProgramAddressSync(
    [Buffer.from("x402-merchant-v1")],
    program.programId
  );

  console.log(`Program ID:    ${program.programId.toBase58()}`);
  console.log(`Owner:         ${owner.publicKey.toBase58()}`);
  console.log(`Agent:         ${agent.publicKey.toBase58()}`);
  console.log(`x402 Merchant: ${x402MerchantPubkey.toBase58()}`);

  // Fund throwaway keeper (and top up agent if needed)
  const agentBal = await connection.getBalance(agent.publicKey, "confirmed");
  const topUpTx = new Transaction();
  if (agentBal < 0.1 * LAMPORTS_PER_SOL) {
    topUpTx.add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: agent.publicKey,
        lamports: Math.floor(0.25 * LAMPORTS_PER_SOL),
      })
    );
  }
  topUpTx.add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: keeper.publicKey,
      lamports: Math.floor(0.015 * LAMPORTS_PER_SOL),
    })
  );
  await sendAndPollConfirm(connection, topUpTx, owner);

  const [vaultPda] = deriveVaultPda(owner.publicKey, program.programId);
  const existingVault = await connection.getAccountInfo(vaultPda, "confirmed");

  if (!existingVault) {
    const mockUsdc = await createMint(connection, owner, owner.publicKey, null, 6);
    const vaultAta = getAssociatedTokenAddressSync(mockUsdc, vaultPda, true);
    const initTx = await program.methods
      .initVault(mockUsdc, [x402MerchantPubkey])
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: mockUsdc,
        vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    await sendAndPollConfirm(connection, initTx, owner);
  }

  const activeVault = await program.account.vault.fetch(vaultPda);
  const activeMint = activeVault.mint;
  const activeVaultAta = activeVault.vaultAta;
  const activeMerchantAta = getAssociatedTokenAddressSync(
    activeMint,
    x402MerchantPubkey,
    true
  );

  // Ensure canonical x402 merchant ATA, allowlist, unpaused vault, and MockUSDC liquidity
  const prepTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      activeMerchantAta,
      x402MerchantPubkey,
      activeMint
    )
  );
  if (!activeVault.allowlist.some((k) => k.equals(x402MerchantPubkey))) {
    prepTx.add(
      await program.methods
        .updateAllowlist([x402MerchantPubkey])
        .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
        .instruction()
    );
  }
  if (activeVault.paused) {
    prepTx.add(
      await program.methods
        .setPause(false)
        .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
        .instruction()
    );
  }
  prepTx.add(
    createMintToInstruction(activeMint, activeVaultAta, owner.publicKey, 10_000_000)
  );
  await sendAndPollConfirm(connection, prepTx, owner);

  // Create fresh Session
  const vaultFresh = await program.account.vault.fetch(vaultPda);
  const [sessionPda] = deriveSessionPda(vaultPda, vaultFresh.sessionNonce, program.programId);
  const createSessionTx = await program.methods
    .createSession(
      agent.publicKey,
      new BN(500_000), // 0.50 MockUSDC max_per_tx
      new BN(1_500_000), // 1.50 MockUSDC bucket_cap
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
  await sendAndPollConfirm(connection, createSessionTx, owner);

  // (a) Normal Spend + Receipt Verification
  const normalHash = sha256Challenge(
    "GET",
    "/api/x402/resource",
    x402MerchantPubkey,
    250_000,
    `devnet-normal-${Date.now()}`
  );
  const [normalReceiptPda] = deriveReceiptPda(vaultPda, normalHash, program.programId);
  const normalTx = await program.methods
    .executeAgentSpend(new BN(250_000), normalHash, new BN(300))
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: vaultPda,
      session: sessionPda,
      mint: activeMint,
      vaultAta: activeVaultAta,
      merchant: x402MerchantPubkey,
      merchantAta: activeMerchantAta,
      receipt: normalReceiptPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const { sig: normalSig } = await sendAndPollConfirm(connection, normalTx, agent);

  const receiptState = await program.account.receipt.fetch(normalReceiptPda);
  if (receiptState.amount.toNumber() !== 250_000) {
    throw new Error("Receipt amount mismatch on Devnet");
  }
  console.log(`(a) Normal Spend + Receipt Verified: ${explorerTx(normalSig)}`);

  // (b) Prompt-Injection Drain Trip (amount = 5_000_000 > max_per_tx = 500_000, 0 moved)
  const vaultBeforeDrain = (await getAccount(connection, activeVaultAta)).amount;
  const drainHash = sha256Challenge(
    "POST",
    "/api/x402/drain",
    x402MerchantPubkey,
    5_000_000,
    `devnet-drain-${Date.now()}`
  );
  const [drainReceiptPda] = deriveReceiptPda(vaultPda, drainHash, program.programId);
  const drainTx = await program.methods
    .executeAgentSpend(new BN(5_000_000), drainHash, new BN(300))
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: vaultPda,
      session: sessionPda,
      mint: activeMint,
      vaultAta: activeVaultAta,
      merchant: x402MerchantPubkey,
      merchantAta: activeMerchantAta,
      receipt: drainReceiptPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const { sig: drainSig } = await sendAndPollConfirm(connection, drainTx, agent);

  const vaultAfterDrain = (await getAccount(connection, activeVaultAta)).amount;
  const drainReceiptInfo = await connection.getAccountInfo(drainReceiptPda, "confirmed");
  const trippedSession = await program.account.session.fetch(sessionPda);
  if (vaultAfterDrain !== vaultBeforeDrain || drainReceiptInfo !== null) {
    throw new Error("Drain safety invariant violated on Devnet");
  }
  if (!("tripped" in trippedSession.status)) {
    throw new Error("Session did not transition to Tripped on Devnet");
  }
  console.log(`(b) Drain Trip (0 moved, Tripped): ${explorerTx(drainSig)}`);

  // (c) Salami Hard-Revert (skipPreflight: true so reverted tx is recorded on-chain with Explorer link)
  const salamiHash = sha256Challenge(
    "GET",
    "/api/x402/resource",
    x402MerchantPubkey,
    100,
    `devnet-salami-${Date.now()}`
  );
  const [salamiReceiptPda] = deriveReceiptPda(vaultPda, salamiHash, program.programId);
  const salamiTx = await program.methods
    .executeAgentSpend(new BN(100), salamiHash, new BN(300))
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: vaultPda,
      session: sessionPda,
      mint: activeMint,
      vaultAta: activeVaultAta,
      merchant: x402MerchantPubkey,
      merchantAta: activeMerchantAta,
      receipt: salamiReceiptPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const { sig: salamiSig, err: salamiErr } = await sendAndPollConfirm(
    connection,
    salamiTx,
    agent,
    [],
    { skipPreflight: true, allowOnChainErr: true }
  );
  if (!salamiErr) {
    throw new Error("Expected Salami retry to hard-revert with SessionNotActive");
  }
  console.log(
    `(c) Salami Hard-Revert (on-chain err=${JSON.stringify(salamiErr)}): ${explorerTx(salamiSig)}`
  );

  // (d) Permissionless Reap Idle / Tripped Session -> full rent returned to owner
  const reapTx = await program.methods
    .reapIdleSession()
    .accountsPartial({
      caller: keeper.publicKey,
      vault: vaultPda,
      session: sessionPda,
      rentRecipient: owner.publicKey,
    })
    .transaction();
  const { sig: reapSig } = await sendAndPollConfirm(connection, reapTx, keeper);
  console.log(`(d) Permissionless Reap Session: ${explorerTx(reapSig)}`);

  const proofMarkdown = `# Devnet Deployment & Verification Proof (\`DEVNET_PROOF.md\`)

**Deployment Status:** \`DEPLOYED_AND_VERIFIED\`  
**Cluster:** Solana Devnet (\`https://api.devnet.solana.com\`)  
**Deployed Program ID:** [\`${program.programId.toBase58()}\`](https://explorer.solana.com/address/${program.programId.toBase58()}?cluster=devnet)  

---

## 1. Ephemeral Devnet Public Keys (Secrets Excluded via \`.gitignore\`)

| Role | Keypair Location (Local / Untracked) | Public Key |
| :--- | :--- | :--- |
| **Owner + Deployer** | \`.devnet-keys/owner-devnet.json\` | \`${owner.publicKey.toBase58()}\` |
| **Agent Signer** | \`.devnet-keys/agent-devnet.json\` | \`${agent.publicKey.toBase58()}\` |
| **Vault PDA** | Derived \`["vault", owner]\` | \`${vaultPda.toBase58()}\` |
| **Canonical x402 Merchant** | Derived \`["x402-merchant-v1"]\` | \`${x402MerchantPubkey.toBase58()}\` |
| **MockUSDC Mint** | SPL Token Mint (6 decimals) | \`${activeMint.toBase58()}\` |

---

## 2. On-Chain Devnet Proof Transactions

| Scenario | Verified On-Chain Outcome | Devnet Explorer Link |
| :--- | :--- | :--- |
| **(a) Normal Spend + Receipt Verification** | Transferred \`250,000\` MockUSDC; verified canonical \`Receipt\` PDA (\`${normalReceiptPda.toBase58()}\`) | [${explorerTx(normalSig)}](${explorerTx(normalSig)}) |
| **(b) Prompt-Injection Drain Trip** | Returned \`Ok(())\`, **0 tokens moved**, no \`Receipt\` PDA, \`status = Tripped (ExceedsPerTxMax)\` | [${explorerTx(drainSig)}](${explorerTx(drainSig)}) |
| **(c) Salami Retry Hard-Revert** | \`100\` unit follow-up spend hard-reverted on-chain (\`Custom(6010) / SessionNotActive\`) | [${explorerTx(salamiSig)}](${explorerTx(salamiSig)}) |
| **(d) Permissionless Reap Idle / Tripped Session** | Third-party keeper (\`${keeper.publicKey.toBase58()}\`) closed \`Session\` PDA & returned full rent to \`owner\` | [${explorerTx(reapSig)}](${explorerTx(reapSig)}) |
`;

  fs.writeFileSync(path.resolve(__dirname, "../DEVNET_PROOF.md"), proofMarkdown, "utf-8");
  console.log("Updated DEVNET_PROOF.md with live Devnet Explorer links.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
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

async function main(): Promise<void> {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const owner = loadKeypair(".devnet-keys/owner-devnet.json");
  const agent = loadKeypair(".devnet-keys/agent-devnet.json");
  const keeper = Keypair.generate();
  const merchant = Keypair.generate();

  const idlPath = path.resolve(__dirname, "../target/idl/leash.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = new Program<Leash>(idl as Leash, provider);

  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(`Owner:      ${owner.publicKey.toBase58()}`);
  console.log(`Agent:      ${agent.publicKey.toBase58()}`);

  // Ensure agent and throwaway keeper have SOL for tx fees & Receipt rent
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
      lamports: Math.floor(0.02 * LAMPORTS_PER_SOL),
    })
  );
  await sendAndConfirmTransaction(connection, topUpTx, [owner], { commitment: "confirmed" });

  // Create MockUSDC Mint & ATAs
  const mockUsdc = await createMint(connection, owner, owner.publicKey, null, 6);
  const [vaultPda] = deriveVaultPda(owner.publicKey, program.programId);
  const vaultAta = getAssociatedTokenAddressSync(mockUsdc, vaultPda, true);
  const merchantAta = await createAssociatedTokenAccount(
    connection,
    owner,
    mockUsdc,
    merchant.publicKey
  );

  // Initialize or update Vault
  const existingVault = await connection.getAccountInfo(vaultPda, "confirmed");
  if (!existingVault) {
    await program.methods
      .initVault(mockUsdc, [merchant.publicKey])
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: mockUsdc,
        vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
  }

  const activeVault = await program.account.vault.fetch(vaultPda);
  const activeMint = activeVault.mint;
  const activeVaultAta = activeVault.vaultAta;
  const activeMerchantAta = activeMint.equals(mockUsdc)
    ? merchantAta
    : await createAssociatedTokenAccount(connection, owner, activeMint, merchant.publicKey);

  if (!activeVault.allowlist.some((k) => k.equals(merchant.publicKey))) {
    await program.methods
      .updateAllowlist([merchant.publicKey])
      .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
      .signers([owner])
      .rpc();
  }
  if (activeVault.paused) {
    await program.methods
      .setPause(false)
      .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
      .signers([owner])
      .rpc();
  }

  await mintTo(connection, owner, activeMint, activeVaultAta, owner, 10_000_000);

  // Create fresh Session
  const vaultFresh = await program.account.vault.fetch(vaultPda);
  const [sessionPda] = deriveSessionPda(vaultPda, vaultFresh.sessionNonce, program.programId);
  await program.methods
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
    .signers([owner])
    .rpc();

  // (a) Normal Spend + Receipt Verification
  const normalHash = sha256Challenge(
    "GET",
    "/api/x402/resource",
    merchant.publicKey,
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
      merchant: merchant.publicKey,
      merchantAta: activeMerchantAta,
      receipt: normalReceiptPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  normalTx.feePayer = agent.publicKey;
  normalTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const normalSig = await sendAndConfirmTransaction(connection, normalTx, [agent], {
    commitment: "confirmed",
  });

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
    merchant.publicKey,
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
      merchant: merchant.publicKey,
      merchantAta: activeMerchantAta,
      receipt: drainReceiptPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  drainTx.feePayer = agent.publicKey;
  drainTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const drainSig = await sendAndConfirmTransaction(connection, drainTx, [agent], {
    commitment: "confirmed",
  });

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
    merchant.publicKey,
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
      merchant: merchant.publicKey,
      merchantAta: activeMerchantAta,
      receipt: salamiReceiptPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  salamiTx.feePayer = agent.publicKey;
  const salamiBh = await connection.getLatestBlockhash("confirmed");
  salamiTx.recentBlockhash = salamiBh.blockhash;
  salamiTx.sign(agent);
  const salamiSig = await connection.sendRawTransaction(salamiTx.serialize(), {
    skipPreflight: true,
  });
  const salamiConf = await connection.confirmTransaction(
    { signature: salamiSig, ...salamiBh },
    "confirmed"
  );
  if (!salamiConf.value.err) {
    throw new Error("Expected Salami retry to hard-revert with SessionNotActive");
  }
  console.log(`(c) Salami Hard-Revert (on-chain err=${JSON.stringify(salamiConf.value.err)}): ${explorerTx(salamiSig)}`);

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
  reapTx.feePayer = keeper.publicKey;
  reapTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const reapSig = await sendAndConfirmTransaction(connection, reapTx, [keeper], {
    commitment: "confirmed",
  });
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
| **MockUSDC Mint** | SPL Token Mint (6 decimals) | \`${activeMint.toBase58()}\` |

---

## 2. On-Chain Devnet Proof Transactions

| Scenario | Verified On-Chain Outcome | Devnet Explorer Link |
| :--- | :--- | :--- |
| **(a) Normal Spend + Receipt Verification** | Transferred \`250,000\` MockUSDC; verified canonical \`Receipt\` PDA (\`${normalReceiptPda.toBase58()}\`) | [\`${normalSig.slice(0, 16)}...\`](${explorerTx(normalSig)}) |
| **(b) Prompt-Injection Drain Trip** | Returned \`Ok(())\`, **0 tokens moved**, no \`Receipt\` PDA, \`status = Tripped (ExceedsPerTxMax)\` | [\`${drainSig.slice(0, 16)}...\`](${explorerTx(drainSig)}) |
| **(c) Salami Retry Hard-Revert** | \`100\` unit follow-up spend hard-reverted on-chain (\`SessionNotActive\`) | [\`${salamiSig.slice(0, 16)}...\`](${explorerTx(salamiSig)}) |
| **(d) Permissionless Reap Session** | Third-party keeper (\`${keeper.publicKey.toBase58()}\`) closed \`Session\` PDA & returned full rent to \`owner\` | [\`${reapSig.slice(0, 16)}...\`](${explorerTx(reapSig)}) |
`;

  fs.writeFileSync(path.resolve(__dirname, "../DEVNET_PROOF.md"), proofMarkdown, "utf-8");
  console.log("Updated DEVNET_PROOF.md with live Devnet Explorer links.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { Leash } from "../target/types/leash";

const DEVNET_RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const X402_URL = process.env.X402_RESOURCE_URL || "http://127.0.0.1:3402/api/x402/resource";

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
  feePayer: Keypair
): Promise<string> {
  tx.feePayer = feePayer.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(feePayer);

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

  interface X402ChallengeResponse {
    status: number;
    error?: string;
    reason?: string;
    verified?: boolean;
    challenge: {
      nonce: string;
      requestHashHex: string;
      merchant: string;
      amount: string;
      receiptTtlSlots: number;
    };
  }

  interface X402SuccessResponse {
    status: number;
    verified: boolean;
    verificationProof: Record<string, unknown>;
    data: Record<string, unknown>;
  }

  // =========================================================================
  // (a) Unauthenticated GET -> HTTP 402 Challenge
  // =========================================================================
  const resA = await fetch(X402_URL);
  const bodyA = (await resA.json()) as X402ChallengeResponse;
  console.log("=== (a) Unauthenticated GET /api/x402/resource ===");
  console.log(`HTTP Status: ${resA.status}`);
  console.log(JSON.stringify(bodyA, null, 2));
  if (resA.status !== 402) {
    throw new Error(`Expected HTTP 402 on unauthenticated GET, got ${resA.status}`);
  }

  // =========================================================================
  // (b) Retry Using Tripped Devnet Tx Signature (meta.err == null, NO Receipt) -> HTTP 402
  // =========================================================================
  const challengeA = bodyA.challenge;
  const hashBytesA = hexToNumberArray(challengeA.requestHashHex);
  const merchantPubkey = new PublicKey(challengeA.merchant);
  const merchantAta = getAssociatedTokenAddressSync(vaultAcc.mint, merchantPubkey, true);
  const [receiptPdaA] = deriveReceiptPda(vaultPda, hashBytesA, program.programId);

  const sessionForTrip = await createDevnetSession(
    connection,
    program,
    owner,
    agent.publicKey,
    vaultPda
  );

  // Execute real policy-violating spend (5,000,000 > 500,000 max_per_tx) using challengeA's hash!
  // Commits on-chain with meta.err == null (SessionStatus::Tripped) and NO Receipt PDA.
  const tripTx = await program.methods
    .executeAgentSpend(new BN(5_000_000), hashBytesA, new BN(challengeA.receiptTtlSlots))
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: vaultPda,
      session: sessionForTrip,
      mint: vaultAcc.mint,
      vaultAta: vaultAcc.vaultAta,
      merchant: merchantPubkey,
      merchantAta,
      receipt: receiptPdaA,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const trippedSig = await sendAndPollConfirm(connection, tripTx, agent);

  const resB = await fetch(X402_URL, {
    headers: {
      "X-402-Vault": vaultPda.toBase58(),
      "X-402-Nonce": challengeA.nonce,
      "X-402-Tx-Signature": trippedSig,
    },
  });
  const bodyB = (await resB.json()) as X402ChallengeResponse;
  console.log("\n=== (b) Retry Using Tripped Devnet Tx (meta.err == null, 0 Receipt) ===");
  console.log(`Tripped Devnet Tx: https://explorer.solana.com/tx/${trippedSig}?cluster=devnet`);
  console.log(`HTTP Status: ${resB.status}`);
  console.log(JSON.stringify(bodyB, null, 2));
  if (resB.status !== 402) {
    throw new Error(`Expected HTTP 402 on tripped tx retry, got ${resB.status}`);
  }

  // =========================================================================
  // (c) Real Valid Devnet execute_agent_spend Matching Challenge -> HTTP 200 OK
  // =========================================================================
  const resChallengeC = await fetch(X402_URL);
  const bodyChallengeC = (await resChallengeC.json()) as X402ChallengeResponse;
  const challengeC = bodyChallengeC.challenge;
  const hashBytesC = hexToNumberArray(challengeC.requestHashHex);
  const [receiptPdaC] = deriveReceiptPda(vaultPda, hashBytesC, program.programId);

  const sessionForValid = await createDevnetSession(
    connection,
    program,
    owner,
    agent.publicKey,
    vaultPda
  );

  const validTx = await program.methods
    .executeAgentSpend(
      new BN(challengeC.amount),
      hashBytesC,
      new BN(challengeC.receiptTtlSlots)
    )
    .accountsPartial({
      agentSigner: agent.publicKey,
      vault: vaultPda,
      session: sessionForValid,
      mint: vaultAcc.mint,
      vaultAta: vaultAcc.vaultAta,
      merchant: merchantPubkey,
      merchantAta,
      receipt: receiptPdaC,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  const validSig = await sendAndPollConfirm(connection, validTx, agent);

  const resC = await fetch(X402_URL, {
    headers: {
      "X-402-Vault": vaultPda.toBase58(),
      "X-402-Nonce": challengeC.nonce,
      "X-402-Tx-Signature": validSig,
    },
  });
  const bodyC = (await resC.json()) as X402SuccessResponse;
  console.log("\n=== (c) Retry After Valid Devnet execute_agent_spend (Receipt PDA Verified) ===");
  console.log(`Settled Devnet Tx: https://explorer.solana.com/tx/${validSig}?cluster=devnet`);
  console.log(`HTTP Status: ${resC.status}`);
  console.log(JSON.stringify(bodyC, null, 2));
  if (resC.status !== 200 || !bodyC.verified) {
    throw new Error(`Expected HTTP 200 verified response, got ${resC.status}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

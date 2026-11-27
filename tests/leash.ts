import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  approve,
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
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";
import { Leash } from "../target/types/leash";

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
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("session"), vault.toBuffer(), nonceBuf],
    programId
  );
}

function deriveReceiptPda(
  vault: PublicKey,
  requestHash: number[] | Uint8Array | Buffer,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), vault.toBuffer(), Buffer.from(requestHash)],
    programId
  );
}

function buildX402RequestHash(
  method: string,
  path: string,
  merchant: PublicKey,
  amount: bigint | number,
  nonce: string
): number[] {
  const canonical = `${method}|${path}|${merchant.toBase58()}|${amount.toString()}|${nonce}`;
  return Array.from(createHash("sha256").update(canonical).digest());
}

async function readOnChainClock(
  connection: Connection
): Promise<{ slot: bigint; unixTimestamp: bigint }> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!info) {
    throw new Error("SYSVAR_CLOCK_PUBKEY missing");
  }
  return {
    slot: info.data.readBigUInt64LE(0),
    unixTimestamp: info.data.readBigInt64LE(32),
  };
}

async function waitForSlot(connection: Connection, targetSlot: bigint): Promise<void> {
  while (true) {
    const { slot } = await readOnChainClock(connection);
    if (slot >= targetSlot) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForUnixTimestamp(
  connection: Connection,
  targetTs: bigint
): Promise<void> {
  while (true) {
    const { unixTimestamp } = await readOnChainClock(connection);
    if (unixTimestamp >= targetTs) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function expectAnchorRevert(
  promise: Promise<unknown>,
  expectedSubstring: string
): Promise<void> {
  let failed = false;
  try {
    await promise;
  } catch (err: unknown) {
    failed = true;
    const msg = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
    expect(msg.toLowerCase()).to.include(
      expectedSubstring.toLowerCase(),
      `Expected error containing "${expectedSubstring}", got: ${msg}`
    );
  }
  expect(failed, `Expected transaction to revert with "${expectedSubstring}", but it succeeded`).to
    .be.true;
}

describe("leash — Adversarial Security & Circuit-Breaker Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const program = anchor.workspace.Leash as Program<Leash>;

  const owner = Keypair.generate();
  const ownerB = Keypair.generate();
  const agent = Keypair.generate();
  const attacker = Keypair.generate();
  const keeper = Keypair.generate();
  const merchant1 = Keypair.generate();
  const merchant2 = Keypair.generate();
  const rogueMerchant = Keypair.generate();
  const delegateKey = Keypair.generate();

  let usdcMint: PublicKey;
  let fakeMint: PublicKey;
  let vaultPda: PublicKey;
  let vaultAta: PublicKey;
  let ownerAta: PublicKey;
  let merchant1Ata: PublicKey;
  let merchant2Ata: PublicKey;
  let rogueMerchantAta: PublicKey;
  let attackerAta: PublicKey;
  let merchant1FakeMintAta: PublicKey;

  let vaultBPda: PublicKey;
  let vaultBAta: PublicKey;

  async function fundSol(pubkey: PublicKey, sol: number): Promise<void> {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  async function executeSpendWithFeePayer(params: {
    signer: Keypair;
    vault?: PublicKey;
    session: PublicKey;
    mint?: PublicKey;
    vaultAta?: PublicKey;
    merchant: PublicKey;
    merchantAta: PublicKey;
    amount: number | BN;
    requestHash: number[];
    receiptTtlSlots: number | BN;
    receiptOverride?: PublicKey;
  }): Promise<{ sig: string; receiptPda: PublicKey }> {
    const targetVault = params.vault ?? vaultPda;
    const [derivedReceipt] = deriveReceiptPda(
      targetVault,
      params.requestHash,
      program.programId
    );
    const receiptAccount = params.receiptOverride ?? derivedReceipt;

    const tx = await program.methods
      .executeAgentSpend(
        new BN(params.amount.toString()),
        params.requestHash,
        new BN(params.receiptTtlSlots.toString())
      )
      .accountsPartial({
        agentSigner: params.signer.publicKey,
        vault: targetVault,
        session: params.session,
        mint: params.mint ?? usdcMint,
        vaultAta: params.vaultAta ?? vaultAta,
        merchant: params.merchant,
        merchantAta: params.merchantAta,
        receipt: receiptAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    tx.feePayer = params.signer.publicKey;
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;

    const sig = await sendAndConfirmTransaction(connection, tx, [params.signer], {
      commitment: "confirmed",
    });

    return { sig, receiptPda: receiptAccount };
  }

  async function createStandardSession(overrides?: {
    agentPubkey?: PublicKey;
    maxPerTx?: number;
    bucketCap?: number;
    windowSecs?: number;
    lifetimeCap?: number;
    idleTimeoutSecs?: number;
  }): Promise<PublicKey> {
    const vaultAcc = await program.account.vault.fetch(vaultPda);
    const [sessionPda] = deriveSessionPda(vaultPda, vaultAcc.sessionNonce, program.programId);

    const tx = await program.methods
      .createSession(
        overrides?.agentPubkey ?? agent.publicKey,
        new BN(overrides?.maxPerTx ?? 1_000_000),
        new BN(overrides?.bucketCap ?? 2_000_000),
        new BN(overrides?.windowSecs ?? 10),
        new BN(overrides?.lifetimeCap ?? 5_000_000),
        new BN(overrides?.idleTimeoutSecs ?? 60)
      )
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        session: sessionPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    tx.feePayer = owner.publicKey;
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    await sendAndConfirmTransaction(connection, tx, [owner], { commitment: "confirmed" });

    return sessionPda;
  }

  before(async () => {
    await Promise.all([
      fundSol(owner.publicKey, 10),
      fundSol(ownerB.publicKey, 10),
      fundSol(agent.publicKey, 5),
      fundSol(attacker.publicKey, 5),
      fundSol(keeper.publicKey, 5),
      fundSol(merchant2.publicKey, 2),
    ]);

    usdcMint = await createMint(connection, owner, owner.publicKey, null, 6);
    fakeMint = await createMint(connection, attacker, attacker.publicKey, null, 6);

    [vaultPda] = deriveVaultPda(owner.publicKey, program.programId);
    vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

    [vaultBPda] = deriveVaultPda(ownerB.publicKey, program.programId);
    vaultBAta = getAssociatedTokenAddressSync(usdcMint, vaultBPda, true);

    ownerAta = await createAssociatedTokenAccount(connection, owner, usdcMint, owner.publicKey);
    merchant1Ata = await createAssociatedTokenAccount(
      connection,
      owner,
      usdcMint,
      merchant1.publicKey
    );
    merchant2Ata = await createAssociatedTokenAccount(
      connection,
      owner,
      usdcMint,
      merchant2.publicKey
    );
    rogueMerchantAta = await createAssociatedTokenAccount(
      connection,
      owner,
      usdcMint,
      rogueMerchant.publicKey
    );
    attackerAta = await createAssociatedTokenAccount(
      connection,
      attacker,
      usdcMint,
      attacker.publicKey
    );
    merchant1FakeMintAta = await createAssociatedTokenAccount(
      connection,
      attacker,
      fakeMint,
      merchant1.publicKey
    );
  });

  it("1. Enforces Vault allowlist bounds (<= 16) and deduplication on init_vault", async () => {
    const seventeenKeys = Array.from({ length: 17 }, () => Keypair.generate().publicKey);
    await expectAnchorRevert(
      program.methods
        .initVault(usdcMint, seventeenKeys)
        .accountsPartial({
          owner: owner.publicKey,
          vault: vaultPda,
          mint: usdcMint,
          vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc(),
      "AllowlistTooLarge"
    );

    await expectAnchorRevert(
      program.methods
        .initVault(usdcMint, [merchant1.publicKey, merchant1.publicKey])
        .accountsPartial({
          owner: owner.publicKey,
          vault: vaultPda,
          mint: usdcMint,
          vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc(),
      "DuplicateAllowlistEntry"
    );
  });

  it("2. Happy path: init_vault, create_session, valid execute_agent_spend, replay rejection, and close_expired_receipt rent reclaim", async () => {
    await program.methods
      .initVault(usdcMint, [merchant1.publicKey, merchant2.publicKey])
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Fund vault ATA with 20.000000 MockUSDC
    await mintTo(connection, owner, usdcMint, vaultAta, owner, 20_000_000);

    const vaultState = await program.account.vault.fetch(vaultPda);
    expect(vaultState.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(vaultState.mint.toBase58()).to.equal(usdcMint.toBase58());
    expect(vaultState.vaultAta.toBase58()).to.equal(vaultAta.toBase58());
    expect(vaultState.paused).to.equal(false);
    expect(vaultState.sessionNonce.toNumber()).to.equal(0);
    expect(vaultState.allowlist.map((k) => k.toBase58())).to.deep.equal([
      merchant1.publicKey.toBase58(),
      merchant2.publicKey.toBase58(),
    ]);

    // Reject zero-value session configs
    const [badSessionPda] = deriveSessionPda(vaultPda, 0, program.programId);
    await expectAnchorRevert(
      program.methods
        .createSession(
          agent.publicKey,
          new BN(0),
          new BN(1_000_000),
          new BN(10),
          new BN(5_000_000),
          new BN(60)
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: vaultPda,
          session: badSessionPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc(),
      "InvalidSessionConfig"
    );

    const sessionPda = await createStandardSession({
      maxPerTx: 1_000_000,
      bucketCap: 2_000_000,
      windowSecs: 60,
      lifetimeCap: 5_000_000,
      idleTimeoutSecs: 120,
    });

    const vaultAfterSession = await program.account.vault.fetch(vaultPda);
    expect(vaultAfterSession.sessionNonce.toNumber()).to.equal(1);

    const ownerSolBefore = await connection.getBalance(owner.publicKey, "confirmed");
    const vaultTokenBefore = (await getAccount(connection, vaultAta)).amount;
    const merchantTokenBefore = (await getAccount(connection, merchant1Ata)).amount;

    const spendAmount = 425_000;
    const reqHash = buildX402RequestHash(
      "GET",
      "/api/x402/resource",
      merchant1.publicKey,
      spendAmount,
      "nonce-happy-1"
    );

    const { receiptPda } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: spendAmount,
      requestHash: reqHash,
      receiptTtlSlots: 4,
    });

    // Vault owner paid ZERO lamports for agent spend + Receipt rent (anti-fee-griefing)
    const ownerSolAfter = await connection.getBalance(owner.publicKey, "confirmed");
    expect(ownerSolAfter).to.equal(ownerSolBefore);

    // Exact SPL token delta
    const vaultTokenAfter = (await getAccount(connection, vaultAta)).amount;
    const merchantTokenAfter = (await getAccount(connection, merchant1Ata)).amount;
    expect(vaultTokenBefore - vaultTokenAfter).to.equal(BigInt(spendAmount));
    expect(merchantTokenAfter - merchantTokenBefore).to.equal(BigInt(spendAmount));

    // Leaky-bucket & lifetime state updated accurately
    const sessionAfter = await program.account.session.fetch(sessionPda);
    expect(sessionAfter.status).to.deep.equal({ active: {} });
    expect(sessionAfter.tripReason).to.deep.equal({ none: {} });
    expect(sessionAfter.lifetimeSpent.toNumber()).to.equal(spendAmount);
    expect(sessionAfter.bucketTokens.toNumber()).to.be.at.most(2_000_000 - spendAmount + 100_000);
    expect(sessionAfter.bucketTokens.toNumber()).to.be.at.least(2_000_000 - spendAmount);

    // Canonical Receipt PDA fields verified
    const receipt = await program.account.receipt.fetch(receiptPda);
    expect(receipt.vault.toBase58()).to.equal(vaultPda.toBase58());
    expect(receipt.session.toBase58()).to.equal(sessionPda.toBase58());
    expect(receipt.merchant.toBase58()).to.equal(merchant1.publicKey.toBase58());
    expect(receipt.amount.toNumber()).to.equal(spendAmount);
    expect(Array.from(receipt.requestHash)).to.deep.equal(reqHash);
    expect(receipt.rentPayer.toBase58()).to.equal(agent.publicKey.toBase58());

    // Duplicate request_hash replay MUST hard-revert without tripping active session
    await expectAnchorRevert(
      executeSpendWithFeePayer({
        signer: agent,
        session: sessionPda,
        merchant: merchant1.publicKey,
        merchantAta: merchant1Ata,
        amount: spendAmount,
        requestHash: reqHash,
        receiptTtlSlots: 4,
      }),
      "ReceiptAlreadyExists"
    );

    const sessionStillActive = await program.account.session.fetch(sessionPda);
    expect(sessionStillActive.status).to.deep.equal({ active: {} });

    // Create a long-TTL receipt to prove premature close_expired_receipt reverts
    const longTtlHash = buildX402RequestHash(
      "GET",
      "/api/x402/resource",
      merchant1.publicKey,
      100_000,
      "nonce-long-ttl"
    );
    const { receiptPda: longReceiptPda } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 100_000,
      requestHash: longTtlHash,
      receiptTtlSlots: 10_000,
    });

    await expectAnchorRevert(
      program.methods
        .closeExpiredReceipt()
        .accountsPartial({
          caller: keeper.publicKey,
          receipt: longReceiptPda,
          rentRecipient: agent.publicKey,
        })
        .signers([keeper])
        .rpc(),
      "ReceiptNotExpired"
    );

    // Wait for short-TTL receipt expiry_slot
    await waitForSlot(connection, BigInt(receipt.expirySlot.toString()));

    // Wrong rent_recipient rejected even after expiry
    await expectAnchorRevert(
      program.methods
        .closeExpiredReceipt()
        .accountsPartial({
          caller: keeper.publicKey,
          receipt: receiptPda,
          rentRecipient: attacker.publicKey,
        })
        .signers([keeper])
        .rpc(),
      "InvalidRentRecipient"
    );

    // Permissionless keeper closes expired receipt -> full rent returned to agent_signer
    const receiptAccountInfoBefore = await connection.getAccountInfo(receiptPda, "confirmed");
    expect(receiptAccountInfoBefore).to.not.be.null;
    const expectedRentReturn = receiptAccountInfoBefore!.lamports;
    const agentSolBeforeClose = await connection.getBalance(agent.publicKey, "confirmed");

    const closeTx = await program.methods
      .closeExpiredReceipt()
      .accountsPartial({
        caller: keeper.publicKey,
        receipt: receiptPda,
        rentRecipient: agent.publicKey,
      })
      .transaction();
    closeTx.feePayer = keeper.publicKey;
    const bh = await connection.getLatestBlockhash("confirmed");
    closeTx.recentBlockhash = bh.blockhash;
    await sendAndConfirmTransaction(connection, closeTx, [keeper], { commitment: "confirmed" });

    const receiptAccountInfoAfter = await connection.getAccountInfo(receiptPda, "confirmed");
    expect(receiptAccountInfoAfter).to.be.null;

    const agentSolAfterClose = await connection.getBalance(agent.publicKey, "confirmed");
    expect(agentSolAfterClose - agentSolBeforeClose).to.equal(expectedRentReturn);
  });

  it("3. Prompt-injection drain (amount > max_per_tx) soft-trips with 0 moved & NO Receipt, and salami retry hard-reverts", async () => {
    const sessionPda = await createStandardSession({
      maxPerTx: 500_000,
      bucketCap: 2_000_000,
      windowSecs: 30,
      lifetimeCap: 5_000_000,
      idleTimeoutSecs: 120,
    });

    const vaultBefore = (await getAccount(connection, vaultAta)).amount;
    const merchantBefore = (await getAccount(connection, merchant1Ata)).amount;

    const drainHash = buildX402RequestHash(
      "POST",
      "/api/x402/drain",
      merchant1.publicKey,
      5_000_000,
      "inject-drain-1"
    );

    // Returns Ok(()) so tripped state commits permanently on-chain
    const { receiptPda: drainReceiptPda } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 5_000_000, // 10x max_per_tx!
      requestHash: drainHash,
      receiptTtlSlots: 20,
    });

    // ZERO tokens moved
    const vaultAfter = (await getAccount(connection, vaultAta)).amount;
    const merchantAfter = (await getAccount(connection, merchant1Ata)).amount;
    expect(vaultAfter).to.equal(vaultBefore);
    expect(merchantAfter).to.equal(merchantBefore);

    // NO Receipt PDA allocated or initialized (closes non-reverting x402 trap!)
    const receiptInfo = await connection.getAccountInfo(drainReceiptPda, "confirmed");
    expect(receiptInfo).to.be.null;

    // Session permanently Tripped with ExceedsPerTxMax
    const sessionState = await program.account.session.fetch(sessionPda);
    expect(sessionState.status).to.deep.equal({ tripped: {} });
    expect(sessionState.tripReason).to.deep.equal({ exceedsPerTxMax: {} });
    expect(sessionState.lifetimeSpent.toNumber()).to.equal(0);

    // Salami retry: immediate tiny valid spend (100 base units) MUST hard-revert with SessionNotActive
    const salamiHash = buildX402RequestHash(
      "GET",
      "/api/x402/resource",
      merchant1.publicKey,
      100,
      "salami-retry-1"
    );
    await expectAnchorRevert(
      executeSpendWithFeePayer({
        signer: agent,
        session: sessionPda,
        merchant: merchant1.publicKey,
        merchantAta: merchant1Ata,
        amount: 100,
        requestHash: salamiHash,
        receiptTtlSlots: 20,
      }),
      "SessionNotActive"
    );

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultBefore);
  });

  it("4. Unallowlisted merchant trips circuit breaker with MerchantNotAllowlisted and 0 tokens moved", async () => {
    const sessionPda = await createStandardSession();
    const vaultBefore = (await getAccount(connection, vaultAta)).amount;
    const rogueBefore = (await getAccount(connection, rogueMerchantAta)).amount;

    const reqHash = buildX402RequestHash(
      "POST",
      "/api/exfil",
      rogueMerchant.publicKey,
      100_000,
      "rogue-merchant-1"
    );

    const { receiptPda } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: rogueMerchant.publicKey,
      merchantAta: rogueMerchantAta,
      amount: 100_000,
      requestHash: reqHash,
      receiptTtlSlots: 20,
    });

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultBefore);
    expect((await getAccount(connection, rogueMerchantAta)).amount).to.equal(rogueBefore);
    expect(await connection.getAccountInfo(receiptPda, "confirmed")).to.be.null;

    const sessionState = await program.account.session.fetch(sessionPda);
    expect(sessionState.status).to.deep.equal({ tripped: {} });
    expect(sessionState.tripReason).to.deep.equal({ merchantNotAllowlisted: {} });
  });

  it("5. Spoofed merchant ATA (wrong owner OR delegated ATA) trips with InvalidMerchantAta and 0 tokens moved", async () => {
    // 5a: Allowlisted merchant pubkey passed with attacker-owned ATA
    const sessionSpoofOwner = await createStandardSession();
    const vaultBefore = (await getAccount(connection, vaultAta)).amount;
    const attackerBefore = (await getAccount(connection, attackerAta)).amount;

    const spoofHash = buildX402RequestHash(
      "POST",
      "/api/spoof",
      merchant1.publicKey,
      200_000,
      "spoof-ata-owner"
    );

    const { receiptPda: spoofReceipt } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionSpoofOwner,
      merchant: merchant1.publicKey, // Allowlisted!
      merchantAta: attackerAta, // Owned by attacker!
      amount: 200_000,
      requestHash: spoofHash,
      receiptTtlSlots: 20,
    });

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultBefore);
    expect((await getAccount(connection, attackerAta)).amount).to.equal(attackerBefore);
    expect(await connection.getAccountInfo(spoofReceipt, "confirmed")).to.be.null;

    const spoofState = await program.account.session.fetch(sessionSpoofOwner);
    expect(spoofState.status).to.deep.equal({ tripped: {} });
    expect(spoofState.tripReason).to.deep.equal({ invalidMerchantAta: {} });

    // 5b: Allowlisted merchant2 whose ATA has an active SPL delegate
    await approve(
      connection,
      merchant2,
      merchant2Ata,
      delegateKey.publicKey,
      merchant2,
      1_000_000
    );

    const sessionDelegated = await createStandardSession();
    const delegatedHash = buildX402RequestHash(
      "POST",
      "/api/delegated",
      merchant2.publicKey,
      200_000,
      "spoof-delegated-ata"
    );

    const { receiptPda: delegatedReceipt } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionDelegated,
      merchant: merchant2.publicKey,
      merchantAta: merchant2Ata,
      amount: 200_000,
      requestHash: delegatedHash,
      receiptTtlSlots: 20,
    });

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultBefore);
    expect(await connection.getAccountInfo(delegatedReceipt, "confirmed")).to.be.null;

    const delegatedState = await program.account.session.fetch(sessionDelegated);
    expect(delegatedState.status).to.deep.equal({ tripped: {} });
    expect(delegatedState.tripReason).to.deep.equal({ invalidMerchantAta: {} });
  });

  it("6. Wrong SPL mint substitution & cross-vault account substitution (Session A with Vault B) fail closed", async () => {
    // Initialize Vault B owned by ownerB and fund it
    await program.methods
      .initVault(usdcMint, [merchant1.publicKey])
      .accountsPartial({
        owner: ownerB.publicKey,
        vault: vaultBPda,
        mint: usdcMint,
        vaultAta: vaultBAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([ownerB])
      .rpc();
    await mintTo(connection, owner, usdcMint, vaultBAta, owner, 5_000_000);

    const sessionFromVaultA = await createStandardSession();
    const vaultABefore = (await getAccount(connection, vaultAta)).amount;
    const vaultBBefore = (await getAccount(connection, vaultBAta)).amount;

    // 6a: Substitute wrong SPL mint account -> hard reverts with InvalidMint
    const badMintHash = buildX402RequestHash(
      "GET",
      "/api/mint-sub",
      merchant1.publicKey,
      100_000,
      "wrong-mint-1"
    );
    await expectAnchorRevert(
      executeSpendWithFeePayer({
        signer: agent,
        session: sessionFromVaultA,
        mint: fakeMint,
        merchant: merchant1.publicKey,
        merchantAta: merchant1FakeMintAta,
        amount: 100_000,
        requestHash: badMintHash,
        receiptTtlSlots: 20,
      }),
      "InvalidMint"
    );

    // 6b: Cross-vault substitution (Session from Vault A passed with Vault B + Vault B ATA) -> hard reverts with VaultMismatch
    const crossVaultHash = buildX402RequestHash(
      "GET",
      "/api/cross-vault",
      merchant1.publicKey,
      100_000,
      "cross-vault-1"
    );
    await expectAnchorRevert(
      executeSpendWithFeePayer({
        signer: agent,
        vault: vaultBPda,
        vaultAta: vaultBAta,
        session: sessionFromVaultA,
        merchant: merchant1.publicKey,
        merchantAta: merchant1Ata,
        amount: 100_000,
        requestHash: crossVaultHash,
        receiptTtlSlots: 20,
      }),
      "VaultMismatch"
    );

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultABefore);
    expect((await getAccount(connection, vaultBAta)).amount).to.equal(vaultBBefore);
  });

  it("7. Leaky-bucket rate limit prevents 2x tumbling-window burst attacks and trips with ExceedsRateBucket", async () => {
    // bucket_cap = 1_000_000, window_secs = 10 -> refills 100_000 tokens/sec continuously
    const sessionPda = await createStandardSession({
      maxPerTx: 1_000_000,
      bucketCap: 1_000_000,
      windowSecs: 10,
      lifetimeCap: 10_000_000,
      idleTimeoutSecs: 120,
    });

    // Drain full bucket_cap (1_000_000)
    const burst1Hash = buildX402RequestHash(
      "GET",
      "/api/burst-1",
      merchant1.publicKey,
      1_000_000,
      "leaky-1"
    );
    await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 1_000_000,
      requestHash: burst1Hash,
      receiptTtlSlots: 20,
    });

    const afterDrain = await program.account.session.fetch(sessionPda);
    expect(afterDrain.bucketTokens.toNumber()).to.equal(0);

    // Advance ~2 seconds on-chain (refills ~200_000-300_000, far below 1_000_000 tumbling reset)
    const targetTs = BigInt(afterDrain.lastRefillTs.toString()) + 2n;
    await waitForUnixTimestamp(connection, targetTs);

    // Spend 150_000 succeeds using partial continuous refill
    const partialHash = buildX402RequestHash(
      "GET",
      "/api/partial",
      merchant1.publicKey,
      150_000,
      "leaky-2"
    );
    await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 150_000,
      requestHash: partialHash,
      receiptTtlSlots: 20,
    });

    // Immediate 2x burst attempt (800_000 <= max_per_tx, but > available_tokens) MUST trip ExceedsRateBucket
    const vaultBefore = (await getAccount(connection, vaultAta)).amount;
    const burst2Hash = buildX402RequestHash(
      "GET",
      "/api/burst-2",
      merchant1.publicKey,
      800_000,
      "leaky-3"
    );
    const { receiptPda: burstReceipt } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 800_000,
      requestHash: burst2Hash,
      receiptTtlSlots: 20,
    });

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultBefore);
    expect(await connection.getAccountInfo(burstReceipt, "confirmed")).to.be.null;

    const trippedSession = await program.account.session.fetch(sessionPda);
    expect(trippedSession.status).to.deep.equal({ tripped: {} });
    expect(trippedSession.tripReason).to.deep.equal({ exceedsRateBucket: {} });
  });

  it("8. Lifetime cap exact edge: succeeds at exact lifetime_cap and trips with ExceedsLifetimeCap on +1 token", async () => {
    const sessionPda = await createStandardSession({
      maxPerTx: 1_000_000,
      bucketCap: 3_000_000,
      windowSecs: 10,
      lifetimeCap: 1_500_000,
      idleTimeoutSecs: 120,
    });

    await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 1_000_000,
      requestHash: buildX402RequestHash("GET", "/api/lt-1", merchant1.publicKey, 1_000_000, "lt-1"),
      receiptTtlSlots: 20,
    });

    // Exact edge: 1_000_000 + 500_000 == 1_500_000 (lifetime_cap) -> MUST succeed
    await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 500_000,
      requestHash: buildX402RequestHash("GET", "/api/lt-2", merchant1.publicKey, 500_000, "lt-2"),
      receiptTtlSlots: 20,
    });

    const atExactCap = await program.account.session.fetch(sessionPda);
    expect(atExactCap.status).to.deep.equal({ active: {} });
    expect(atExactCap.lifetimeSpent.toNumber()).to.equal(1_500_000);

    // +1 base unit (amount = 1) -> MUST soft-trip with ExceedsLifetimeCap & 0 moved
    const vaultBefore = (await getAccount(connection, vaultAta)).amount;
    const plusOneHash = buildX402RequestHash("GET", "/api/lt-3", merchant1.publicKey, 1, "lt-3");
    const { receiptPda } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 1,
      requestHash: plusOneHash,
      receiptTtlSlots: 20,
    });

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultBefore);
    expect(await connection.getAccountInfo(receiptPda, "confirmed")).to.be.null;

    const afterPlusOne = await program.account.session.fetch(sessionPda);
    expect(afterPlusOne.status).to.deep.equal({ tripped: {} });
    expect(afterPlusOne.tripReason).to.deep.equal({ exceedsLifetimeCap: {} });
    expect(afterPlusOne.lifetimeSpent.toNumber()).to.equal(1_500_000);
  });

  it("9. Blocks unauthorized privilege escalation across all owner & agent instructions", async () => {
    const sessionPda = await createStandardSession();

    // Agent or attacker calling update_allowlist fails
    for (const badActor of [agent, attacker]) {
      await expectAnchorRevert(
        program.methods
          .updateAllowlist([attacker.publicKey])
          .accountsPartial({
            owner: badActor.publicKey,
            vault: vaultPda,
          })
          .signers([badActor])
          .rpc(),
        "ConstraintSeeds"
      );

      await expectAnchorRevert(
        program.methods
          .setPause(true)
          .accountsPartial({
            owner: badActor.publicKey,
            vault: vaultPda,
          })
          .signers([badActor])
          .rpc(),
        "ConstraintSeeds"
      );

      await expectAnchorRevert(
        program.methods
          .revokeSession()
          .accountsPartial({
            owner: badActor.publicKey,
            vault: vaultPda,
            session: sessionPda,
          })
          .signers([badActor])
          .rpc(),
        "ConstraintSeeds"
      );

      await expectAnchorRevert(
        program.methods
          .ownerWithdraw(new BN(100_000))
          .accountsPartial({
            owner: badActor.publicKey,
            vault: vaultPda,
            mint: usdcMint,
            vaultAta,
            ownerAta: attackerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([badActor])
          .rpc(),
        "Constraint"
      );
    }

    // Non-agent (attacker or even vault owner) calling execute_agent_spend fails with UnauthorizedAgent
    for (const nonAgent of [attacker, owner]) {
      await expectAnchorRevert(
        executeSpendWithFeePayer({
          signer: nonAgent,
          session: sessionPda,
          merchant: merchant1.publicKey,
          merchantAta: merchant1Ata,
          amount: 50_000,
          requestHash: buildX402RequestHash(
            "GET",
            "/api/unauth",
            merchant1.publicKey,
            50_000,
            `unauth-${nonAgent.publicKey.toBase58().slice(0, 6)}`
          ),
          receiptTtlSlots: 10,
        }),
        "UnauthorizedAgent"
      );
    }

    // Owner revoking session sets Revoked and blocks further spends permanently
    await program.methods
      .revokeSession()
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        session: sessionPda,
      })
      .signers([owner])
      .rpc();

    const revokedState = await program.account.session.fetch(sessionPda);
    expect(revokedState.status).to.deep.equal({ revoked: {} });

    await expectAnchorRevert(
      executeSpendWithFeePayer({
        signer: agent,
        session: sessionPda,
        merchant: merchant1.publicKey,
        merchantAta: merchant1Ata,
        amount: 50_000,
        requestHash: buildX402RequestHash(
          "GET",
          "/api/after-revoke",
          merchant1.publicKey,
          50_000,
          "revoked-spend"
        ),
        receiptTtlSlots: 10,
      }),
      "SessionNotActive"
    );
  });

  it("10. Permissionless reap_idle_session enforces active/idle & rent_recipient invariants and returns full rent to vault.owner", async () => {
    const activeIdleSession = await createStandardSession({ idleTimeoutSecs: 2 });
    const spendIdleSession = await createStandardSession({ idleTimeoutSecs: 2 });

    // Fails while active and non-idle
    await expectAnchorRevert(
      program.methods
        .reapIdleSession()
        .accountsPartial({
          caller: keeper.publicKey,
          vault: vaultPda,
          session: activeIdleSession,
          rentRecipient: owner.publicKey,
        })
        .signers([keeper])
        .rpc(),
      "SessionStillActive"
    );

    // Wait > idle_timeout_secs past the later-created session (now - last_active_ts >= 3 > 2)
    const spendSessionData = await program.account.session.fetch(spendIdleSession);
    await waitForUnixTimestamp(connection, BigInt(spendSessionData.lastActiveTs.toString()) + 3n);

    // Agent attempting spend after idle timeout soft-trips with SessionIdleExpired
    const idleSpendHash = buildX402RequestHash(
      "GET",
      "/api/idle-spend",
      merchant1.publicKey,
      50_000,
      "idle-expired-spend"
    );
    const { receiptPda: idleReceipt } = await executeSpendWithFeePayer({
      signer: agent,
      session: spendIdleSession,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 50_000,
      requestHash: idleSpendHash,
      receiptTtlSlots: 10,
    });
    expect(await connection.getAccountInfo(idleReceipt, "confirmed")).to.be.null;
    const idleTrippedState = await program.account.session.fetch(spendIdleSession);
    expect(idleTrippedState.status).to.deep.equal({ tripped: {} });
    expect(idleTrippedState.tripReason).to.deep.equal({ sessionIdleExpired: {} });

    // Fails if rent_recipient != vault.owner
    await expectAnchorRevert(
      program.methods
        .reapIdleSession()
        .accountsPartial({
          caller: keeper.publicKey,
          vault: vaultPda,
          session: activeIdleSession,
          rentRecipient: keeper.publicKey,
        })
        .signers([keeper])
        .rpc(),
      "InvalidRentRecipient"
    );

    // Permissionless third party reaps BOTH idle-expired active session AND tripped session -> full rent to vault.owner
    for (const targetSession of [activeIdleSession, spendIdleSession]) {
      const sessionInfoBefore = await connection.getAccountInfo(targetSession, "confirmed");
      expect(sessionInfoBefore).to.not.be.null;
      const sessionRent = sessionInfoBefore!.lamports;
      const ownerSolBefore = await connection.getBalance(owner.publicKey, "confirmed");

      const reapTx = await program.methods
        .reapIdleSession()
        .accountsPartial({
          caller: keeper.publicKey,
          vault: vaultPda,
          session: targetSession,
          rentRecipient: owner.publicKey,
        })
        .transaction();
      reapTx.feePayer = keeper.publicKey;
      const bh = await connection.getLatestBlockhash("confirmed");
      reapTx.recentBlockhash = bh.blockhash;
      await sendAndConfirmTransaction(connection, reapTx, [keeper], { commitment: "confirmed" });

      expect(await connection.getAccountInfo(targetSession, "confirmed")).to.be.null;
      const ownerSolAfter = await connection.getBalance(owner.publicKey, "confirmed");
      expect(ownerSolAfter - ownerSolBefore).to.equal(sessionRent);
    }
  });

  it("11. Global set_pause(true) trips agent spends with VaultPaused while owner_withdraw still succeeds", async () => {
    const sessionPda = await createStandardSession();

    await program.methods
      .setPause(true)
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
      })
      .signers([owner])
      .rpc();

    const pausedVault = await program.account.vault.fetch(vaultPda);
    expect(pausedVault.paused).to.equal(true);

    const vaultTokensBeforeSpend = (await getAccount(connection, vaultAta)).amount;
    const pausedHash = buildX402RequestHash(
      "GET",
      "/api/paused",
      merchant1.publicKey,
      100_000,
      "paused-spend-1"
    );
    const { receiptPda } = await executeSpendWithFeePayer({
      signer: agent,
      session: sessionPda,
      merchant: merchant1.publicKey,
      merchantAta: merchant1Ata,
      amount: 100_000,
      requestHash: pausedHash,
      receiptTtlSlots: 10,
    });

    expect((await getAccount(connection, vaultAta)).amount).to.equal(vaultTokensBeforeSpend);
    expect(await connection.getAccountInfo(receiptPda, "confirmed")).to.be.null;

    const trippedByPause = await program.account.session.fetch(sessionPda);
    expect(trippedByPause.status).to.deep.equal({ tripped: {} });
    expect(trippedByPause.tripReason).to.deep.equal({ vaultPaused: {} });

    // Owner emergency withdrawal succeeds even while vault.paused == true
    const withdrawAmount = 750_000;
    const ownerTokensBefore = (await getAccount(connection, ownerAta)).amount;

    await program.methods
      .ownerWithdraw(new BN(withdrawAmount))
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        vaultAta,
        ownerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    const ownerTokensAfter = (await getAccount(connection, ownerAta)).amount;
    const vaultTokensAfterWithdraw = (await getAccount(connection, vaultAta)).amount;
    expect(ownerTokensAfter - ownerTokensBefore).to.equal(BigInt(withdrawAmount));
    expect(vaultTokensBeforeSpend - vaultTokensAfterWithdraw).to.equal(BigInt(withdrawAmount));

    // Unpause cleanly and test update_allowlist deduplication enforcement
    await program.methods
      .setPause(false)
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
      })
      .signers([owner])
      .rpc();

    await expectAnchorRevert(
      program.methods
        .updateAllowlist([merchant1.publicKey, merchant1.publicKey])
        .accountsPartial({
          owner: owner.publicKey,
          vault: vaultPda,
        })
        .signers([owner])
        .rpc(),
      "DuplicateAllowlistEntry"
    );

    await program.methods
      .updateAllowlist([merchant1.publicKey])
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
      })
      .signers([owner])
      .rpc();

    const updatedVault = await program.account.vault.fetch(vaultPda);
    expect(updatedVault.paused).to.equal(false);
    expect(updatedVault.allowlist.map((k) => k.toBase58())).to.deep.equal([
      merchant1.publicKey.toBase58(),
    ]);
  });
});

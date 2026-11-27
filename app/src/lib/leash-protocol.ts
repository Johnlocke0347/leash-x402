import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import leashIdl from "./leash-idl.json";

export const DEFAULT_DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

export const LEASH_PROGRAM_ID = new PublicKey(leashIdl.address);

// Deterministic canonical x402 Merchant PDA (off-curve wallet owning standard SPL ATA; zero private keys stored)
export const X402_MERCHANT_PUBKEY = PublicKey.findProgramAddressSync(
  [new TextEncoder().encode("x402-merchant-v1")],
  LEASH_PROGRAM_ID
)[0];

export const X402_CHALLENGE_AMOUNT = 250_000n; // 0.250000 USDC (6 decimals)
export const X402_DRAIN_AMOUNT = 5_000_000n; // 5.000000 USDC (10x max_per_tx)
export const X402_SALAMI_AMOUNT = 100n; // 0.000100 USDC
export const X402_RECEIPT_TTL_SLOTS = 300n;

const enc = new TextEncoder();

export const ACCOUNT_DISCRIMINATORS = {
  vault: new Uint8Array([211, 8, 232, 43, 2, 152, 117, 119]),
  session: new Uint8Array([243, 81, 72, 115, 214, 188, 72, 144]),
  receipt: new Uint8Array([39, 154, 73, 106, 80, 102, 145, 153]),
} as const;

export const IX_DISCRIMINATORS = {
  initVault: new Uint8Array([77, 79, 85, 150, 33, 217, 52, 106]),
  updateAllowlist: new Uint8Array([138, 59, 153, 23, 244, 206, 40, 245]),
  setPause: new Uint8Array([63, 32, 154, 2, 56, 103, 79, 45]),
  createSession: new Uint8Array([242, 193, 143, 179, 150, 25, 122, 227]),
  executeAgentSpend: new Uint8Array([0, 37, 111, 252, 90, 59, 204, 58]),
  revokeSession: new Uint8Array([86, 92, 198, 120, 144, 2, 7, 194]),
  reapIdleSession: new Uint8Array([165, 4, 51, 3, 100, 95, 17, 86]),
  closeExpiredReceipt: new Uint8Array([44, 147, 254, 203, 230, 85, 178, 63]),
} as const;

export type SessionStatusLabel = "Active" | "Tripped" | "Revoked";

export type TripReasonLabel =
  | "None"
  | "VaultPaused"
  | "MerchantNotAllowlisted"
  | "ExceedsPerTxMax"
  | "ExceedsRateBucket"
  | "ExceedsLifetimeCap"
  | "SessionIdleExpired"
  | "InvalidMerchantAta";

const SESSION_STATUS_MAP: readonly SessionStatusLabel[] = [
  "Active",
  "Tripped",
  "Revoked",
];

const TRIP_REASON_MAP: readonly TripReasonLabel[] = [
  "None",
  "VaultPaused",
  "MerchantNotAllowlisted",
  "ExceedsPerTxMax",
  "ExceedsRateBucket",
  "ExceedsLifetimeCap",
  "SessionIdleExpired",
  "InvalidMerchantAta",
];

export interface DecodedVault {
  address: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  vaultAta: PublicKey;
  paused: boolean;
  sessionNonce: bigint;
  allowlist: PublicKey[];
  bump: number;
}

export interface DecodedSession {
  address: PublicKey;
  vault: PublicKey;
  agentSigner: PublicKey;
  nonce: bigint;
  maxPerTx: bigint;
  bucketCap: bigint;
  bucketTokens: bigint;
  windowSecs: bigint;
  lastRefillTs: bigint;
  lifetimeCap: bigint;
  lifetimeSpent: bigint;
  idleTimeoutSecs: bigint;
  lastActiveTs: bigint;
  status: SessionStatusLabel;
  tripReason: TripReasonLabel;
  bump: number;
}

export interface DecodedReceipt {
  address: PublicKey;
  vault: PublicKey;
  session: PublicKey;
  merchant: PublicKey;
  amount: bigint;
  requestHashHex: string;
  requestHashBytes: Uint8Array;
  expirySlot: bigint;
  rentPayer: PublicKey;
  bump: number;
}

function matchesDiscriminator(data: Uint8Array, disc: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/, "");
  if (clean.length !== 64) {
    throw new Error("Expected 32-byte SHA-256 hex digest (64 hex chars)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function deriveVaultPda(
  owner: PublicKey,
  programId: PublicKey = LEASH_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc.encode("vault"), owner.toBytes()],
    programId
  );
}

export function deriveSessionPda(
  vault: PublicKey,
  nonce: bigint,
  programId: PublicKey = LEASH_PROGRAM_ID
): [PublicKey, number] {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, true);
  return PublicKey.findProgramAddressSync(
    [enc.encode("session"), vault.toBytes(), nonceBytes],
    programId
  );
}

export function deriveReceiptPda(
  vault: PublicKey,
  requestHash: Uint8Array,
  programId: PublicKey = LEASH_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc.encode("receipt"), vault.toBytes(), requestHash],
    programId
  );
}

export function decodeVault(address: PublicKey, raw: Uint8Array): DecodedVault {
  if (!matchesDiscriminator(raw, ACCOUNT_DISCRIMINATORS.vault)) {
    throw new Error("Invalid Vault account discriminator");
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const owner = new PublicKey(raw.subarray(8, 40));
  const mint = new PublicKey(raw.subarray(40, 72));
  const vaultAta = new PublicKey(raw.subarray(72, 104));
  const paused = raw[104] !== 0;
  const sessionNonce = dv.getBigUint64(105, true);
  const allowlistLen = dv.getUint32(113, true);
  const allowlist: PublicKey[] = [];
  let cursor = 117;
  for (let i = 0; i < allowlistLen; i++) {
    allowlist.push(new PublicKey(raw.subarray(cursor, cursor + 32)));
    cursor += 32;
  }
  const bump = raw[cursor];

  return {
    address,
    owner,
    mint,
    vaultAta,
    paused,
    sessionNonce,
    allowlist,
    bump,
  };
}

export function decodeSession(address: PublicKey, raw: Uint8Array): DecodedSession {
  if (raw.length < 155 || !matchesDiscriminator(raw, ACCOUNT_DISCRIMINATORS.session)) {
    throw new Error("Invalid Session account discriminator or size");
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const statusIdx = raw[152];
  const reasonIdx = raw[153];

  return {
    address,
    vault: new PublicKey(raw.subarray(8, 40)),
    agentSigner: new PublicKey(raw.subarray(40, 72)),
    nonce: dv.getBigUint64(72, true),
    maxPerTx: dv.getBigUint64(80, true),
    bucketCap: dv.getBigUint64(88, true),
    bucketTokens: dv.getBigUint64(96, true),
    windowSecs: dv.getBigUint64(104, true),
    lastRefillTs: dv.getBigInt64(112, true),
    lifetimeCap: dv.getBigUint64(120, true),
    lifetimeSpent: dv.getBigUint64(128, true),
    idleTimeoutSecs: dv.getBigInt64(136, true),
    lastActiveTs: dv.getBigInt64(144, true),
    status: SESSION_STATUS_MAP[statusIdx] ?? "Tripped",
    tripReason: TRIP_REASON_MAP[reasonIdx] ?? "None",
    bump: raw[154],
  };
}

export function decodeReceipt(address: PublicKey, raw: Uint8Array): DecodedReceipt {
  if (raw.length !== 185 || !matchesDiscriminator(raw, ACCOUNT_DISCRIMINATORS.receipt)) {
    throw new Error("Invalid Receipt account discriminator or length");
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const requestHashBytes = new Uint8Array(raw.subarray(112, 144));

  return {
    address,
    vault: new PublicKey(raw.subarray(8, 40)),
    session: new PublicKey(raw.subarray(40, 72)),
    merchant: new PublicKey(raw.subarray(72, 104)),
    amount: dv.getBigUint64(104, true),
    requestHashBytes,
    requestHashHex: bytesToHex(requestHashBytes),
    expirySlot: dv.getBigUint64(144, true),
    rentPayer: new PublicKey(raw.subarray(152, 184)),
    bump: raw[184],
  };
}

export function computeAvailableBucketTokens(
  session: DecodedSession,
  nowUnixSec: bigint
): bigint {
  if (session.windowSecs <= 0n) return session.bucketTokens;
  const rawElapsed = nowUnixSec - session.lastRefillTs;
  const elapsed = rawElapsed > 0n ? rawElapsed : 0n;
  const refill = (elapsed * session.bucketCap) / session.windowSecs;
  const refilled = session.bucketTokens + refill;
  return refilled < session.bucketCap ? refilled : session.bucketCap;
}

export function buildInitVaultIx(params: {
  owner: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  vaultAta: PublicKey;
  initialAllowlist: PublicKey[];
}): TransactionInstruction {
  const count = params.initialAllowlist.length;
  const data = new Uint8Array(8 + 32 + 4 + count * 32);
  data.set(IX_DISCRIMINATORS.initVault, 0);
  data.set(params.mint.toBytes(), 8);
  new DataView(data.buffer).setUint32(40, count, true);
  params.initialAllowlist.forEach((pk, idx) => {
    data.set(pk.toBytes(), 44 + idx * 32);
  });

  return new TransactionInstruction({
    programId: LEASH_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function buildUpdateAllowlistIx(params: {
  owner: PublicKey;
  vault: PublicKey;
  newAllowlist: PublicKey[];
}): TransactionInstruction {
  const count = params.newAllowlist.length;
  const data = new Uint8Array(8 + 4 + count * 32);
  data.set(IX_DISCRIMINATORS.updateAllowlist, 0);
  new DataView(data.buffer).setUint32(8, count, true);
  params.newAllowlist.forEach((pk, idx) => {
    data.set(pk.toBytes(), 12 + idx * 32);
  });

  return new TransactionInstruction({
    programId: LEASH_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.vault, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });
}

export function buildSetPauseIx(params: {
  owner: PublicKey;
  vault: PublicKey;
  paused: boolean;
}): TransactionInstruction {
  const data = new Uint8Array(9);
  data.set(IX_DISCRIMINATORS.setPause, 0);
  data[8] = params.paused ? 1 : 0;

  return new TransactionInstruction({
    programId: LEASH_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.vault, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });
}

export function buildCreateSessionIx(params: {
  owner: PublicKey;
  vault: PublicKey;
  session: PublicKey;
  agentSigner: PublicKey;
  maxPerTx: bigint;
  bucketCap: bigint;
  windowSecs: bigint;
  lifetimeCap: bigint;
  idleTimeoutSecs: bigint;
}): TransactionInstruction {
  const data = new Uint8Array(8 + 32 + 40);
  const dv = new DataView(data.buffer);
  data.set(IX_DISCRIMINATORS.createSession, 0);
  data.set(params.agentSigner.toBytes(), 8);
  dv.setBigUint64(40, params.maxPerTx, true);
  dv.setBigUint64(48, params.bucketCap, true);
  dv.setBigUint64(56, params.windowSecs, true);
  dv.setBigUint64(64, params.lifetimeCap, true);
  dv.setBigInt64(72, params.idleTimeoutSecs, true);

  return new TransactionInstruction({
    programId: LEASH_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: params.session, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function buildExecuteAgentSpendIx(params: {
  agentSigner: PublicKey;
  vault: PublicKey;
  session: PublicKey;
  mint: PublicKey;
  vaultAta: PublicKey;
  merchant: PublicKey;
  merchantAta: PublicKey;
  receipt: PublicKey;
  amount: bigint;
  requestHash: Uint8Array;
  receiptTtlSlots: bigint;
}): TransactionInstruction {
  if (params.requestHash.length !== 32) {
    throw new Error("requestHash must be exactly 32 bytes");
  }
  const data = new Uint8Array(8 + 8 + 32 + 8);
  const dv = new DataView(data.buffer);
  data.set(IX_DISCRIMINATORS.executeAgentSpend, 0);
  dv.setBigUint64(8, params.amount, true);
  data.set(params.requestHash, 16);
  dv.setBigUint64(48, params.receiptTtlSlots, true);

  return new TransactionInstruction({
    programId: LEASH_PROGRAM_ID,
    keys: [
      { pubkey: params.agentSigner, isSigner: true, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: false },
      { pubkey: params.session, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.vaultAta, isSigner: false, isWritable: true },
      { pubkey: params.merchant, isSigner: false, isWritable: false },
      { pubkey: params.merchantAta, isSigner: false, isWritable: true },
      { pubkey: params.receipt, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function buildReapIdleSessionIx(params: {
  caller: PublicKey;
  vault: PublicKey;
  session: PublicKey;
  rentRecipient: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: LEASH_PROGRAM_ID,
    keys: [
      { pubkey: params.caller, isSigner: true, isWritable: false },
      { pubkey: params.vault, isSigner: false, isWritable: false },
      { pubkey: params.session, isSigner: false, isWritable: true },
      { pubkey: params.rentRecipient, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(IX_DISCRIMINATORS.reapIdleSession),
  });
}

export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = (baseUnits % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}.00`;
}

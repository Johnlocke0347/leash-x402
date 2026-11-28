import { Keypair } from "@solana/web3.js";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(input: string): Uint8Array {
  if (!input) {
    throw new Error("Empty base58 string in FAUCET_SECRET_KEY");
  }
  let num = 0n;
  for (let i = 0; i < input.length; i++) {
    const charIdx = BASE58_ALPHABET.indexOf(input[i]);
    if (charIdx < 0) {
      throw new Error("Invalid base58 character in FAUCET_SECRET_KEY");
    }
    num = num * 58n + BigInt(charIdx);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();

  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === "1") {
    leadingZeros++;
  }

  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

function unwrapOuterQuotes(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"')) {
    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (typeof parsed === "string") {
        return parsed.trim();
      }
    } catch {
      // Fall back to stripping outer double quotes directly
    }
    cleaned = cleaned.slice(1, -1).trim();
  } else if (
    cleaned.length >= 2 &&
    cleaned.startsWith("'") &&
    cleaned.endsWith("'")
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

/**
 * Pure parser for a Solana 64-byte secret key string.
 * Supports:
 * - Raw 64-byte JSON array (`[1,2,...]`)
 * - Whitespace / newline-formatted 64-byte JSON array
 * - Double-quoted or single-quoted JSON array string (`"[1,2,...]"`)
 * - Valid base58-encoded 64-byte secret key
 */
export function parseFaucetSecretKey(rawInput: string): Keypair {
  const cleaned = unwrapOuterQuotes(rawInput);
  if (!cleaned) {
    throw new Error("FAUCET_SECRET_KEY is empty");
  }

  if (cleaned.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("Malformed JSON array in FAUCET_SECRET_KEY");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every(
        (n) =>
          typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255
      )
    ) {
      throw new Error(
        "FAUCET_SECRET_KEY JSON array must contain exactly 64 integer bytes (0..255)"
      );
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }

  const decoded = decodeBase58(cleaned);
  if (decoded.length !== 64) {
    throw new Error(
      `FAUCET_SECRET_KEY base58 decoded to ${decoded.length} bytes; expected 64`
    );
  }
  return Keypair.fromSecretKey(decoded);
}

/**
 * Server-only loader for `process.env.FAUCET_SECRET_KEY`.
 * Never import this module into client components.
 */
export function loadServerFaucetKeypair(): Keypair | null {
  const rawSecret = process.env.FAUCET_SECRET_KEY?.trim();
  if (!rawSecret) return null;
  return parseFaucetSecretKey(rawSecret);
}

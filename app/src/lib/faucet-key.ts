import { Keypair } from "@solana/web3.js";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(input: string): Uint8Array {
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

/**
 * Server-only parser for FAUCET_SECRET_KEY (supports JSON 64-byte array or base58).
 * Never import this module into client components.
 */
export function loadServerFaucetKeypair(): Keypair | null {
  const rawSecret = process.env.FAUCET_SECRET_KEY?.trim();
  if (!rawSecret) return null;

  if (rawSecret.startsWith("[")) {
    const parsed = JSON.parse(rawSecret) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => typeof n === "number" && n >= 0 && n <= 255)
    ) {
      throw new Error("FAUCET_SECRET_KEY JSON array must contain 64 bytes");
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }

  return Keypair.fromSecretKey(decodeBase58(rawSecret));
}

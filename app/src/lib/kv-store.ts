/**
 * Lightweight zero-dependency atomic key-value store for serverless replay protection
 * and faucet rate-limiting.
 *
 * Automatically reads UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, falling back to
 * KV_REST_API_URL + KV_REST_API_TOKEN (Vercel Marketplace Upstash / KV integration).
 * Falls back cleanly to a TTL-pruned in-memory Map when Redis env vars are unset in local dev.
 */

export type AtomicStoreMode = "upstash_redis" | "in_memory_fallback";

interface RedisCredentials {
  url: string;
  token: string;
}

const globalForKv = globalThis as unknown as {
  __leashAtomicFallbackMap?: Map<string, number>;
};

const fallbackMap: Map<string, number> =
  globalForKv.__leashAtomicFallbackMap ?? new Map<string, number>();
globalForKv.__leashAtomicFallbackMap = fallbackMap;

function getRedisCredentials(): RedisCredentials | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL?.trim() ||
    process.env.KV_REST_API_URL?.trim() ||
    "";
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
    process.env.KV_REST_API_TOKEN?.trim() ||
    "";

  if (url && token) {
    return { url: url.replace(/\/+$/, ""), token };
  }
  return null;
}

export function getAtomicStoreMode(): AtomicStoreMode {
  return getRedisCredentials() ? "upstash_redis" : "in_memory_fallback";
}

function pruneFallbackMap(nowMs: number): void {
  for (const [key, expiresAt] of fallbackMap.entries()) {
    if (expiresAt <= nowMs) {
      fallbackMap.delete(key);
    }
  }
}

async function execUpstashCommand<T = unknown>(
  creds: RedisCredentials,
  command: (string | number)[]
): Promise<T> {
  const res = await fetch(creds.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });

  const payload = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || payload.error) {
    throw new Error(
      `Upstash Redis REST error (${res.status}): ${payload.error ?? "unknown"}`
    );
  }
  return payload.result as T;
}

/**
 * Atomically claims `key` with TTL `ttlSeconds` if and only if it does not already exist
 * (`["SET", key, "1", "EX", ttlSeconds, "NX"]`).
 */
export async function claimAtomicKey(
  key: string,
  ttlSeconds: number
): Promise<{ acquired: boolean; storeMode: AtomicStoreMode }> {
  const safeTtl = Math.max(1, Math.floor(ttlSeconds));
  const creds = getRedisCredentials();

  if (creds) {
    const result = await execUpstashCommand<string | null>(creds, [
      "SET",
      key,
      "1",
      "EX",
      safeTtl,
      "NX",
    ]);
    return {
      acquired: result === "OK",
      storeMode: "upstash_redis",
    };
  }

  const nowMs = Date.now();
  pruneFallbackMap(nowMs);
  const existing = fallbackMap.get(key);
  if (existing && existing > nowMs) {
    return { acquired: false, storeMode: "in_memory_fallback" };
  }
  fallbackMap.set(key, nowMs + safeTtl * 1000);
  return { acquired: true, storeMode: "in_memory_fallback" };
}

/**
 * Checks whether `key` currently exists and returns its remaining TTL in seconds.
 */
export async function peekKeyTtlSeconds(
  key: string
): Promise<{ exists: boolean; ttlSeconds: number; storeMode: AtomicStoreMode }> {
  const creds = getRedisCredentials();

  if (creds) {
    const ttl = await execUpstashCommand<number>(creds, ["TTL", key]);
    if (typeof ttl === "number" && ttl > 0) {
      return { exists: true, ttlSeconds: ttl, storeMode: "upstash_redis" };
    }
    if (ttl === -1) {
      return { exists: true, ttlSeconds: 60, storeMode: "upstash_redis" };
    }
    return { exists: false, ttlSeconds: 0, storeMode: "upstash_redis" };
  }

  const nowMs = Date.now();
  pruneFallbackMap(nowMs);
  const expiresAt = fallbackMap.get(key);
  if (expiresAt && expiresAt > nowMs) {
    return {
      exists: true,
      ttlSeconds: Math.max(1, Math.ceil((expiresAt - nowMs) / 1000)),
      storeMode: "in_memory_fallback",
    };
  }
  return { exists: false, ttlSeconds: 0, storeMode: "in_memory_fallback" };
}

/**
 * Deletes `key` (used to release faucet cooldown locks if an upstream RPC send fails).
 */
export async function releaseAtomicKey(key: string): Promise<void> {
  const creds = getRedisCredentials();
  if (creds) {
    await execUpstashCommand<number>(creds, ["DEL", key]).catch(() => undefined);
    return;
  }
  fallbackMap.delete(key);
}

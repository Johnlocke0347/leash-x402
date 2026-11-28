/**
 * Lightweight zero-dependency atomic key-value store for serverless replay protection
 * and faucet rate-limiting.
 *
 * Automatically reads UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, falling back to
 * KV_REST_API_URL + KV_REST_API_TOKEN (Vercel Marketplace Upstash / KV integration).
 * Falls back cleanly to a TTL-pruned in-memory Map when Redis env vars are unset in local dev.
 * When Redis credentials ARE configured, network or HTTP 5xx errors throw so security-critical
 * callers (such as single-use x402 Receipt redemption) fail closed rather than allowing replays.
 */

export type AtomicStoreMode = "upstash_redis" | "in_memory_fallback";

export interface RedisCredentials {
  url: string;
  token: string;
}

interface WindowCounterEntry {
  count: number;
  expiresAt: number;
}

const REDIS_FETCH_TIMEOUT_MS = 10_000;

const globalForKv = globalThis as unknown as {
  __leashAtomicFallbackMap?: Map<string, number>;
  __leashAtomicCounterMap?: Map<string, WindowCounterEntry>;
};

const fallbackMap: Map<string, number> =
  globalForKv.__leashAtomicFallbackMap ?? new Map<string, number>();
globalForKv.__leashAtomicFallbackMap = fallbackMap;

const fallbackCounterMap: Map<string, WindowCounterEntry> =
  globalForKv.__leashAtomicCounterMap ?? new Map<string, WindowCounterEntry>();
globalForKv.__leashAtomicCounterMap = fallbackCounterMap;

export function getRedisCredentials(): RedisCredentials | null {
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

export function resetInMemoryStoreForTests(): void {
  fallbackMap.clear();
  fallbackCounterMap.clear();
}

function pruneFallbackStores(nowMs: number): void {
  for (const [key, expiresAt] of fallbackMap.entries()) {
    if (expiresAt <= nowMs) {
      fallbackMap.delete(key);
    }
  }
  for (const [key, entry] of fallbackCounterMap.entries()) {
    if (entry.expiresAt <= nowMs) {
      fallbackCounterMap.delete(key);
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
    signal: AbortSignal.timeout(REDIS_FETCH_TIMEOUT_MS),
  });

  let payload: { result?: T; error?: string };
  try {
    payload = (await res.json()) as { result?: T; error?: string };
  } catch {
    throw new Error(
      `Upstash Redis REST returned non-JSON response (HTTP ${res.status})`
    );
  }

  if (!res.ok || payload.error) {
    throw new Error(
      `Upstash Redis REST error (${res.status}): ${payload.error ?? "unknown"}`
    );
  }
  return payload.result as T;
}

async function execUpstashPipeline(
  creds: RedisCredentials,
  commands: (string | number)[][]
): Promise<unknown[]> {
  const res = await fetch(`${creds.url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(REDIS_FETCH_TIMEOUT_MS),
  });

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(
      `Upstash Redis pipeline returned non-JSON response (HTTP ${res.status})`
    );
  }

  if (!res.ok || !Array.isArray(payload)) {
    const errMsg =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : "pipeline failure";
    throw new Error(`Upstash Redis pipeline error (${res.status}): ${errMsg}`);
  }

  return payload.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Malformed Upstash pipeline element");
    }
    const entry = item as { result?: unknown; error?: string };
    if (entry.error) {
      throw new Error(`Upstash Redis pipeline command error: ${entry.error}`);
    }
    return entry.result;
  });
}

/**
 * Atomically acquires a lock on `key` with TTL `ttlSeconds` using
 * `["SET", key, "1", "EX", ttlSeconds, "NX"]`.
 * Returns `true` on `{ "result": "OK" }`, `false` on `{ "result": null }`,
 * and throws on Redis HTTP/network failures so callers fail closed.
 */
export async function acquireAtomicLock(
  key: string,
  ttlSeconds: number
): Promise<boolean> {
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
    if (result === "OK") return true;
    if (result === null) return false;
    throw new Error(`Unexpected Upstash SET NX result: ${String(result)}`);
  }

  const nowMs = Date.now();
  pruneFallbackStores(nowMs);
  const existing = fallbackMap.get(key);
  if (existing && existing > nowMs) {
    return false;
  }
  fallbackMap.set(key, nowMs + safeTtl * 1000);
  return true;
}

/**
 * Wrapper around `acquireAtomicLock` that also reports the active `AtomicStoreMode`.
 */
export async function claimAtomicKey(
  key: string,
  ttlSeconds: number
): Promise<{ acquired: boolean; storeMode: AtomicStoreMode }> {
  const storeMode = getAtomicStoreMode();
  const acquired = await acquireAtomicLock(key, ttlSeconds);
  return { acquired, storeMode };
}

/**
 * Fail-closed single-use x402 Receipt redemption helper.
 * Never returns `ok: true` if Redis is unreachable or returns HTTP 5xx.
 */
export async function redeemReceiptAtomically(
  replayKey: string,
  ttlSeconds: number
): Promise<
  | { ok: true; storeMode: AtomicStoreMode }
  | {
      ok: false;
      reason: "already_redeemed" | "store_unavailable";
      httpStatus: 402 | 503;
      error: string;
      storeMode: AtomicStoreMode;
    }
> {
  const storeMode = getAtomicStoreMode();
  try {
    const acquired = await acquireAtomicLock(replayKey, ttlSeconds);
    if (!acquired) {
      return {
        ok: false,
        reason: "already_redeemed",
        httpStatus: 402,
        error: "Receipt already redeemed — single-use x402 settlement enforced.",
        storeMode,
      };
    }
    return { ok: true, storeMode };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "store_unavailable",
      httpStatus: 503,
      error: `Replay protection store unavailable (failing closed): ${detail}`,
      storeMode,
    };
  }
}

/**
 * Atomically increments a fixed-window rate-limit counter for `key` with TTL `windowSeconds`.
 * Uses Upstash REST `/pipeline` (`INCR` + `TTL`, setting `EXPIRE` when `count == 1` or `ttl < 0`)
 * with an in-memory fixed-window fallback when Redis env vars are unset.
 */
export async function incrementWindowCounter(
  key: string,
  windowSeconds: number
): Promise<number> {
  const safeWindow = Math.max(1, Math.floor(windowSeconds));
  const creds = getRedisCredentials();

  if (creds) {
    const [rawCount, rawTtl] = await execUpstashPipeline(creds, [
      ["INCR", key],
      ["TTL", key],
    ]);
    const count = Number(rawCount);
    const ttl = Number(rawTtl);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`Unexpected Upstash INCR result: ${String(rawCount)}`);
    }
    if (count === 1 || ttl === -1) {
      await execUpstashPipeline(creds, [["EXPIRE", key, safeWindow]]);
    }
    return count;
  }

  const nowMs = Date.now();
  pruneFallbackStores(nowMs);
  const existing = fallbackCounterMap.get(key);
  if (!existing || existing.expiresAt <= nowMs) {
    fallbackCounterMap.set(key, {
      count: 1,
      expiresAt: nowMs + safeWindow * 1000,
    });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

/**
 * Best-effort decrement for a window counter if a downstream operation (such as faucet RPC send)
 * fails before completing.
 */
export async function decrementWindowCounter(key: string): Promise<void> {
  const creds = getRedisCredentials();
  if (creds) {
    await execUpstashCommand<number>(creds, ["DECR", key]).catch(() => undefined);
    return;
  }
  const existing = fallbackCounterMap.get(key);
  if (existing) {
    if (existing.count <= 1) {
      fallbackCounterMap.delete(key);
    } else {
      existing.count -= 1;
    }
  }
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
  pruneFallbackStores(nowMs);
  const lockExpiresAt = fallbackMap.get(key);
  if (lockExpiresAt && lockExpiresAt > nowMs) {
    return {
      exists: true,
      ttlSeconds: Math.max(1, Math.ceil((lockExpiresAt - nowMs) / 1000)),
      storeMode: "in_memory_fallback",
    };
  }
  const counterEntry = fallbackCounterMap.get(key);
  if (counterEntry && counterEntry.expiresAt > nowMs) {
    return {
      exists: true,
      ttlSeconds: Math.max(
        1,
        Math.ceil((counterEntry.expiresAt - nowMs) / 1000)
      ),
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
  fallbackCounterMap.delete(key);
}

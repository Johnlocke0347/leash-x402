import assert from "assert";
import http from "http";
import { AddressInfo } from "net";
import { Keypair } from "@solana/web3.js";
import {
  loadServerFaucetKeypair,
  parseFaucetSecretKey,
} from "../app/src/lib/faucet-key";
import {
  acquireAtomicLock,
  getAtomicStoreMode,
  getRedisCredentials,
  incrementWindowCounter,
  redeemReceiptAtomically,
  resetInMemoryStoreForTests,
} from "../app/src/lib/kv-store";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (let i = 0; i < bytes.length; i++) {
    num = (num << 8n) + BigInt(bytes[i]);
  }
  const chars: string[] = [];
  while (num > 0n) {
    const rem = Number(num % 58n);
    chars.push(BASE58_ALPHABET[rem]);
    num /= 58n;
  }
  chars.reverse();
  let leadingOnes = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    leadingOnes += "1";
  }
  return leadingOnes + chars.join("");
}

interface RecordedRequest {
  method: string;
  url: string;
  authHeader: string | undefined;
  body: unknown;
}

interface MockUpstashState {
  kv: Map<string, { value: string; ttl: number }>;
  forceHttp500: boolean;
  requests: RecordedRequest[];
  expireCommandsExecuted: number;
}

function executeSingleCommand(
  state: MockUpstashState,
  cmd: unknown[]
): { result: unknown; error?: string } {
  const op = String(cmd[0] ?? "").toUpperCase();
  const key = String(cmd[1] ?? "");

  if (op === "SET") {
    const val = String(cmd[2] ?? "");
    const exFlag = String(cmd[3] ?? "").toUpperCase();
    const ttl = Number(cmd[4] ?? 0);
    const nxFlag = String(cmd[5] ?? "").toUpperCase();

    if (nxFlag === "NX" && state.kv.has(key)) {
      return { result: null };
    }
    state.kv.set(key, { value: val, ttl: exFlag === "EX" ? ttl : -1 });
    return { result: "OK" };
  }

  if (op === "INCR") {
    const existing = state.kv.get(key);
    if (!existing) {
      state.kv.set(key, { value: "1", ttl: -1 });
      return { result: 1 };
    }
    const nextVal = Number(existing.value) + 1;
    existing.value = String(nextVal);
    return { result: nextVal };
  }

  if (op === "DECR") {
    const existing = state.kv.get(key);
    const nextVal = (existing ? Number(existing.value) : 0) - 1;
    state.kv.set(key, { value: String(nextVal), ttl: existing?.ttl ?? -1 });
    return { result: nextVal };
  }

  if (op === "TTL") {
    const existing = state.kv.get(key);
    if (!existing) return { result: -2 };
    return { result: existing.ttl };
  }

  if (op === "EXPIRE") {
    state.expireCommandsExecuted += 1;
    const ttl = Number(cmd[2] ?? 0);
    const existing = state.kv.get(key);
    if (!existing) return { result: 0 };
    existing.ttl = ttl;
    return { result: 1 };
  }

  if (op === "DEL") {
    const existed = state.kv.delete(key);
    return { result: existed ? 1 : 0 };
  }

  return { result: null, error: `Unsupported mock command: ${op}` };
}

function startMockUpstashServer(expectedToken: string): Promise<{
  server: http.Server;
  baseUrl: string;
  state: MockUpstashState;
}> {
  const state: MockUpstashState = {
    kv: new Map(),
    forceHttp500: false,
    requests: [],
    expireCommandsExecuted: 0,
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const parsedBody = rawBody ? JSON.parse(rawBody) : null;
        state.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authHeader: req.headers.authorization,
          body: parsedBody,
        });

        if (req.headers.authorization !== `Bearer ${expectedToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        if (state.forceHttp500) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Simulated Upstash internal error" }));
          return;
        }

        if (req.url === "/pipeline") {
          assert(
            Array.isArray(parsedBody),
            "Pipeline payload must be an array of commands"
          );
          const results = (parsedBody as unknown[][]).map((cmd) =>
            executeSingleCommand(state, cmd)
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(results));
          return;
        }

        assert(
          Array.isArray(parsedBody),
          "Single Upstash command payload must be an array"
        );
        const out = executeSingleCommand(state, parsedBody as unknown[]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        state,
      });
    });
  });
}

function clearRedisEnv(): void {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

async function run(): Promise<void> {
  console.log("=== Running Serverless Unit Suite (kv-store.ts & faucet-key.ts) ===");

  const mockToken = "mock-upstash-bearer-token-test";
  const { server, baseUrl, state } = await startMockUpstashServer(mockToken);

  try {
    // -------------------------------------------------------------------------
    // 1. acquireAtomicLock exact REST wire format + OK vs null replay rejection
    // -------------------------------------------------------------------------
    clearRedisEnv();
    process.env.UPSTASH_REDIS_REST_URL = `${baseUrl}/`;
    process.env.UPSTASH_REDIS_REST_TOKEN = mockToken;

    assert.strictEqual(getAtomicStoreMode(), "upstash_redis");

    const replayKey = "leash:x402:receipt:deadbeef01";
    const firstLock = await acquireAtomicLock(replayKey, 1800);
    assert.strictEqual(
      firstLock,
      true,
      "First acquireAtomicLock must return true on { result: 'OK' }"
    );

    assert.strictEqual(state.requests.length, 1);
    const req1 = state.requests[0];
    assert.strictEqual(req1.method, "POST");
    assert.strictEqual(req1.url, "/");
    assert.strictEqual(req1.authHeader, `Bearer ${mockToken}`);
    assert.deepStrictEqual(req1.body, [
      "SET",
      replayKey,
      "1",
      "EX",
      1800,
      "NX",
    ]);

    const secondLock = await acquireAtomicLock(replayKey, 1800);
    assert.strictEqual(
      secondLock,
      false,
      "Replay acquireAtomicLock must return false on { result: null }"
    );
    console.log(
      "  [PASS] 1. acquireAtomicLock sends exact Bearer + ['SET', key, '1', 'EX', ttl, 'NX'] & blocks replay"
    );

    // -------------------------------------------------------------------------
    // 2. Both UPSTASH_REDIS_REST_* and Vercel KV_REST_API_* env pairs resolve
    // -------------------------------------------------------------------------
    clearRedisEnv();
    assert.strictEqual(getRedisCredentials(), null);
    assert.strictEqual(getAtomicStoreMode(), "in_memory_fallback");

    process.env.KV_REST_API_URL = `${baseUrl}///`;
    process.env.KV_REST_API_TOKEN = mockToken;
    const kvCreds = getRedisCredentials();
    assert.deepStrictEqual(kvCreds, { url: baseUrl, token: mockToken });
    assert.strictEqual(getAtomicStoreMode(), "upstash_redis");

    const kvLock = await acquireAtomicLock("leash:x402:receipt:kv-fallback-pair", 900);
    assert.strictEqual(kvLock, true);

    process.env.UPSTASH_REDIS_REST_URL = `${baseUrl}/`;
    process.env.UPSTASH_REDIS_REST_TOKEN = mockToken;
    const upstashCreds = getRedisCredentials();
    assert.deepStrictEqual(upstashCreds, { url: baseUrl, token: mockToken });
    console.log(
      "  [PASS] 2. Both UPSTASH_REDIS_REST_* and KV_REST_API_* env pairs resolve cleanly"
    );

    // -------------------------------------------------------------------------
    // 3. Fail-closed behavior on Redis HTTP 500 AND network connection failure
    // -------------------------------------------------------------------------
    state.forceHttp500 = true;

    let lockThrewOn500 = false;
    try {
      await acquireAtomicLock("leash:x402:receipt:http500", 1800);
    } catch {
      lockThrewOn500 = true;
    }
    assert.strictEqual(
      lockThrewOn500,
      true,
      "acquireAtomicLock must throw on HTTP 500"
    );

    const redemptionOn500 = await redeemReceiptAtomically(
      "leash:x402:receipt:http500",
      1800
    );
    assert.strictEqual(
      redemptionOn500.ok,
      false,
      "redeemReceiptAtomically MUST fail closed on Redis HTTP 500"
    );
    if (!redemptionOn500.ok) {
      assert.strictEqual(redemptionOn500.reason, "store_unavailable");
      assert.strictEqual(redemptionOn500.httpStatus, 503);
    }
    state.forceHttp500 = false;

    // Also test network ECONNREFUSED against an unused closed port
    const closedServer = http.createServer();
    await new Promise<void>((r) => closedServer.listen(0, "127.0.0.1", () => r()));
    const closedPort = (closedServer.address() as AddressInfo).port;
    await new Promise<void>((r) => closedServer.close(() => r()));

    process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${closedPort}`;
    const redemptionOnNetErr = await redeemReceiptAtomically(
      "leash:x402:receipt:netdown",
      1800
    );
    assert.strictEqual(
      redemptionOnNetErr.ok,
      false,
      "redeemReceiptAtomically MUST fail closed on Redis network failure"
    );
    if (!redemptionOnNetErr.ok) {
      assert.strictEqual(redemptionOnNetErr.reason, "store_unavailable");
      assert.strictEqual(redemptionOnNetErr.httpStatus, 503);
    }

    // Restore live mock URL
    process.env.UPSTASH_REDIS_REST_URL = baseUrl;
    console.log(
      "  [PASS] 3. Redis HTTP 500 & ECONNREFUSED network errors fail closed (HTTP 503, never 200 OK)"
    );

    // -------------------------------------------------------------------------
    // 4. incrementWindowCounter allows 5 calls and blocks the 6th (Redis + Fallback)
    // -------------------------------------------------------------------------
    state.expireCommandsExecuted = 0;
    const ipWindowKey = "leash:faucet:ipwin:203.0.113.42";
    const maxDrips = 5;
    const countsRedis: number[] = [];

    for (let i = 1; i <= 6; i++) {
      const c = await incrementWindowCounter(ipWindowKey, 600);
      countsRedis.push(c);
    }
    assert.deepStrictEqual(countsRedis, [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(
      countsRedis.slice(0, 5).every((c) => c <= maxDrips),
      true,
      "Calls 1..5 must be allowed"
    );
    assert.strictEqual(
      countsRedis[5] > maxDrips,
      true,
      "6th call must exceed limit (6 > 5) and be blocked"
    );
    assert.strictEqual(
      state.expireCommandsExecuted,
      1,
      "EXPIRE must execute strictly once when count == 1"
    );

    // Verify in-memory fallback counter parity
    clearRedisEnv();
    resetInMemoryStoreForTests();
    const countsMem: number[] = [];
    for (let i = 1; i <= 6; i++) {
      countsMem.push(await incrementWindowCounter(ipWindowKey, 600));
    }
    assert.deepStrictEqual(countsMem, [1, 2, 3, 4, 5, 6]);
    console.log(
      "  [PASS] 4. incrementWindowCounter allows 5 calls and blocks 6th (Upstash pipeline + in-memory)"
    );

    // -------------------------------------------------------------------------
    // 5. faucet-key.ts parses all valid secret formats & rejects malformed keys
    // -------------------------------------------------------------------------
    const sampleKp = Keypair.generate();
    const expectedPubkey = sampleKp.publicKey.toBase58();
    const byteArr = Array.from(sampleKp.secretKey);

    // 5a. Raw 64-byte JSON array
    const rawJsonStr = JSON.stringify(byteArr);
    assert.strictEqual(
      parseFaucetSecretKey(rawJsonStr).publicKey.toBase58(),
      expectedPubkey
    );

    // 5b. Whitespace / newline-formatted JSON array
    const multilineJsonStr = `[\n  ${byteArr.slice(0, 32).join(", ")},\n  ${byteArr
      .slice(32)
      .join(",  ")}\n]\n`;
    assert.strictEqual(
      parseFaucetSecretKey(multilineJsonStr).publicKey.toBase58(),
      expectedPubkey
    );

    // 5c. Double-quoted JSON string "[1,2,...]" AND JSON-encoded string
    const doubleQuotedStr = `"${rawJsonStr}"`;
    assert.strictEqual(
      parseFaucetSecretKey(doubleQuotedStr).publicKey.toBase58(),
      expectedPubkey
    );
    const jsonEncodedStr = JSON.stringify(rawJsonStr);
    assert.strictEqual(
      parseFaucetSecretKey(jsonEncodedStr).publicKey.toBase58(),
      expectedPubkey
    );

    // 5d. Valid base58 secret key (plus loadServerFaucetKeypair env integration)
    const b58Secret = encodeBase58(sampleKp.secretKey);
    assert.strictEqual(
      parseFaucetSecretKey(b58Secret).publicKey.toBase58(),
      expectedPubkey
    );

    process.env.FAUCET_SECRET_KEY = `  "${b58Secret}"  `;
    const envKp = loadServerFaucetKeypair();
    assert(envKp !== null);
    assert.strictEqual(envKp.publicKey.toBase58(), expectedPubkey);

    delete process.env.FAUCET_SECRET_KEY;
    assert.strictEqual(loadServerFaucetKeypair(), null);

    // 5e. Rejects invalid keys cleanly
    const corruptedBytes = [...byteArr];
    corruptedBytes[63] ^= 0xff; // Flip public-key byte so ed25519 keypair check fails

    const invalidInputs = [
      "",
      "   ",
      "[1, 2, 3]", // Wrong length
      JSON.stringify(byteArr.slice(0, 63)), // 63 bytes
      JSON.stringify([...byteArr.slice(0, 63), 256]), // Byte > 255
      JSON.stringify([...byteArr.slice(0, 63), -1]), // Negative byte
      JSON.stringify([...byteArr.slice(0, 63), 1.5]), // Float byte
      "[1, 2, malformed", // Broken JSON
      "0OIlInvalidBase58Chars!", // Illegal base58 chars
      encodeBase58(sampleKp.secretKey.slice(0, 32)), // 32-byte seed instead of 64-byte secretKey
      JSON.stringify(corruptedBytes), // Corrupted ed25519 pubkey bytes
    ];

    for (const bad of invalidInputs) {
      let rejected = false;
      try {
        parseFaucetSecretKey(bad);
      } catch {
        rejected = true;
      }
      assert.strictEqual(
        rejected,
        true,
        `Expected parseFaucetSecretKey to reject invalid input: ${bad.slice(0, 24)}`
      );
    }

    console.log(
      "  [PASS] 5. faucet-key.ts parses raw/multiline/quoted JSON arrays & base58, rejecting all invalid inputs"
    );
    console.log("=== ALL 5 SERVERLESS UNIT SUITES PASSED ===");
  } finally {
    clearRedisEnv();
    delete process.env.FAUCET_SECRET_KEY;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

run().catch((err) => {
  console.error("Serverless unit suite FAILED:", err);
  process.exit(1);
});

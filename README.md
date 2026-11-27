# Leash — Payer-Side Spending Control Plane & Prompt-Injection Circuit Breaker for Solana `x402`

Leash is a non-custodial Solana Anchor protocol that isolates autonomous agent hot keys (`x402` / `Pay.sh`) from treasury custody. A human or multisig **Vault Owner** deposits SPL liquidity into a PDA-controlled vault and issues bounded **Session** mandates to ephemeral **Agent Signers**. Any policy violation commits an irreversible on-chain circuit-breaker trip (`SessionStatus::Tripped`) while transferring **zero** tokens.

- **Deployed Solana Devnet Program ID:** [`Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH`](https://explorer.solana.com/address/Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH?cluster=devnet)
- **Devnet Deploy Transaction:** [`FzaMmyRUyrxWu7EP4Erzkj2yVpKXC1y1aKEywsEZACReDLU9r9ipd1T6MYa6Q55QYr8iMh2kMtC5XcRbLExtXoc`](https://explorer.solana.com/tx/FzaMmyRUyrxWu7EP4Erzkj2yVpKXC1y1aKEywsEZACReDLU9r9ipd1T6MYa6Q55QYr8iMh2kMtC5XcRbLExtXoc?cluster=devnet)
- **On-Chain IDL Account:** [`F4kiQFPBNQ4EYHacVLVRB8g5AT54p7WdwiQtZWo1vuYG`](https://explorer.solana.com/address/F4kiQFPBNQ4EYHacVLVRB8g5AT54p7WdwiQtZWo1vuYG?cluster=devnet)

---

## 1. Threat Model

Autonomous agents executing HTTP `402 Payment Required` workflows hold hot signing keys in untrusted runtime environments exposed to indirect prompt injection, malicious tool responses, and compromised upstream APIs:

| Attack Vector | On-Chain & Verifier Defense in Leash |
| :--- | :--- |
| **Prompt-Injection Vault Drain** (`amount > max_per_tx`) | Soft-trips session (`TripReason::ExceedsPerTxMax`), moves `0` tokens, allocates `0` receipt rent, permanently locks session. |
| **Salami-Slicing Retry After Trip** | Terminal gate: once `status != Active`, every subsequent `execute_agent_spend` (even `1` base unit) hard-reverts with `VaultError::SessionNotActive`. |
| **Exfiltration to Rogue Merchant / Spoofed ATA** | Enforces owner-curated `allowlist` (max 16 unique pubkeys) AND verifies `merchant_ata.owner == merchant`, `merchant_ata.mint == vault.mint`, and `merchant_ata.delegate.is_none()`. |
| **2x Boundary Burst Rate-Limit Bypass** | Continuous `u128` linear leaky-bucket refill eliminates fixed/tumbling window boundary resets. |
| **Non-Reverting `x402` Settlement Spoofing** | Canonical `Receipt` PDA is allocated **only** on the passing settlement path; `/api/x402/resource` verifies the `Receipt` PDA on-chain rather than `tx.meta.err == null`. |
| **Fake-Mint `x402` Vault Substitution** | Challenge binds `mint` in `sha256(method\|path\|merchant\|mint\|amount\|nonce)` AND `/api/x402/resource` fetches both `Receipt` and `Vault` (`receipt.vault`) on-chain to verify `vault.mint == expectedMint`. |
| **Single-Challenge Receipt Replay** | `/api/x402/resource` tracks redeemed `request_hash` digests and rejects repeat redemptions with `HTTP 402` (`Receipt already redeemed`). |
| **Pre-Funded / Dusted `Receipt` PDA DoS** | Uses `create_account` when `lamports == 0`, and falls back to `transfer` shortfall + `allocate` + `assign` signed by `Receipt` PDA seeds when pre-funded with dust lamports. |
| **Vault Owner SOL Fee-Griefing & State Bloat** | `agent_signer` signs and pays tx fees + `Receipt` rent; expired `Receipt` and idle/tripped `Session` PDAs are permissionlessly reapable back to their original rent payers. |
| **Global Emergency Incident** | `set_pause(true)` trips any active agent spend (`VaultPaused`) while `owner_withdraw` remains live at all times. |

---

## 2. Canonical PDA Architecture

1. **`Vault`** — Seeds: `[b"vault", owner.key().as_ref()]` (`630` bytes)
   - Custody root owning the canonical SPL `vault_ata`. Stores `owner`, `mint`, `vault_ata`, `paused`, monotonic `session_nonce`, and deduplicated `allowlist` (`<= 16` merchants).
2. **`Session`** — Seeds: `[b"session", vault.key().as_ref(), &nonce.to_le_bytes()]` (`155` bytes)
   - Scoped mandate binding `agent_signer` to `max_per_tx`, leaky-bucket parameters (`bucket_cap`, `bucket_tokens`, `window_secs`, `last_refill_ts`), `lifetime_cap`, `lifetime_spent`, `idle_timeout_secs`, `last_active_ts`, `status` (`Active | Tripped | Revoked`), and `trip_reason`.
3. **`Receipt`** — Seeds: `[b"receipt", vault.key().as_ref(), &request_hash]` (`185` bytes)
   - Cryptographic `x402` settlement proof recording `vault`, `session`, `merchant`, `amount`, `request_hash`, `expiry_slot`, and `rent_payer`.

See [`SPEC.md`](./SPEC.md) for byte-exact layouts and deterministic policy evaluation order.

---

## 3. Why Continuous Leaky-Bucket Beats Tumbling Windows

A fixed/tumbling window of capacity $C$ over window $W$ allows an adversary to spend $C$ at $t = W - \epsilon$ and another $C$ at $t = W + \epsilon$, draining $2C$ in $2\epsilon$ seconds.

Leash enforces continuous linear refill in checked `u128` arithmetic before every spend:

$$\text{refill} = \left\lfloor \frac{\max(0, t_{\text{now}} - t_{\text{last}}) \times \text{bucket\_cap}}{\text{window\_secs}} \right\rfloor$$

$$\text{available} = \min\left(\text{bucket\_cap},\ \text{bucket\_tokens} + \text{refill}\right)$$

Over any arbitrary interval $\Delta t$, total outflow is strictly upper-bounded by $\text{bucket\_cap} + \lfloor \Delta t \cdot \text{bucket\_cap} / \text{window\_secs} \rfloor$.

---

## 4. Closing the Non-Reverting `x402` Trap, Fake-Mint Bypass & Replay Window

1. **Mint-Bound Challenge Preimage:**  
   `/api/x402/resource` computes:
   ```text
   request_hash = sha256("${method}|${path}|${merchant}|${mint}|${amount}|${nonce}")
   ```
   By default (`ALLOW_SANDBOX_MOCK_MINT !== "true"`), `mint` is locked to `EXPECTED_MINT` (defaulting to Solana Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). Only when `ALLOW_SANDBOX_MOCK_MINT="true"` may a caller supply a sandbox MockUSDC mint via `?mint=` / `X-402-Mint`.
2. **Dual On-Chain `Vault` + `Receipt` PDA Verification:**  
   Because soft-tripped spends commit `SessionStatus::Tripped` in a non-reverting `Ok(())` transaction (`tx.meta.err == null`), `/api/x402/resource` never trusts transaction status alone. It fetches **both** the canonical `Receipt` PDA (`[b"receipt", vault, request_hash]`) and `Vault` PDA (`receipt.vault`) from Solana Devnet, verifying program ownership (`Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH`), canonical bumps, `receipt.vault == headerVault`, `vault.mint == expectedMint`, `receipt.merchant == expectedMerchant`, `receipt.amount == expectedAmount`, `receipt.requestHash == expectedHash`, and `currentSlot < receipt.expirySlot`.
3. **Single-Use Replay Store Caveat:**  
   `/api/x402/resource` maintains a TTL-pruned in-memory `Map<string, number>` of redeemed `requestHashHex` digests so each `Receipt` PDA can unlock a resource only once (`HTTP 402` `"Receipt already redeemed"` on replay). **Production Serverless Note:** In multi-instance or multi-region serverless deployments (such as Vercel), cold starts or separate isolates do not share in-memory `Map` state; production deployments must swap this map for an atomic distributed store such as Upstash Redis or Vercel KV (`SET receipt:<hash> 1 NX PX <ttl>`).

---

## 5. Live Solana Devnet Verification Proof Links

Full details and public keys are recorded in [`DEVNET_PROOF.md`](./DEVNET_PROOF.md):

| Verification Flow | On-Chain / HTTP Outcome | Solana Devnet Explorer Link |
| :--- | :--- | :--- |
| **(a) Normal Spend + Receipt Verification** | Settled `250,000` MockUSDC; created `Receipt` PDA (`2cSiWMAVNiNZyGSeXXcanqpvSF4SCSukY69araoSp4xh`) | [View Tx (`4SghwCco...`)](https://explorer.solana.com/tx/4SghwCcogY9QF4as2UJ9AVk6dm3MQEChPJSbTZNA491YydJDe8VNNQhWjmQk4XLvSDZueCpBxdiPTTV5iZ2MEG3Q?cluster=devnet) |
| **(b) Prompt-Injection Drain Trip** | `Ok(())`, **0 tokens moved**, no `Receipt` PDA, `Tripped (ExceedsPerTxMax)` | [View Tx (`2BMpcD3V...`)](https://explorer.solana.com/tx/2BMpcD3V28hGN6PngMG3y5zKjQzHYLCUpVMgh7r9wvaLxzwfJPgTgtp3jjzs2dFwUTcsaQyBRWjNXMkrebPRBByg?cluster=devnet) |
| **(c) Salami Retry Hard-Revert** | `100` unit retry hard-reverted on-chain (`Custom(6010) / SessionNotActive`) | [View Tx (`8kdt5Vr9...`)](https://explorer.solana.com/tx/8kdt5Vr9Rv5GR9HSNQT1pGutxHVVi7yoE6414Z3jm2WRM1oGiejDXeKVoqn3FmX4yzZxSkxnWEYXHaLyrcxZtZL?cluster=devnet) |
| **(d) Permissionless Reap Session** | Third-party keeper closed `Session` PDA & returned full rent to `vault.owner` | [View Tx (`5ihDcDsr...`)](https://explorer.solana.com/tx/5ihDcDsrCvppfHVuVoxnQXi1Wzc3ktzSA4DsxAtWTW9hV49hZ7Eq1ypw9qi4Bmue1ccXX3mPncx23F3zcEW5YV1X?cluster=devnet) |
| **(e) HTTP `x402` Soft-Trip Spoof Rejected** | Non-reverting tripped tx (`meta.err == null`) rejected by `/api/x402/resource` with `HTTP 402` | [View Tx (`2UT7jbr9...`)](https://explorer.solana.com/tx/2UT7jbr99LYsYyMmJCvmbzkHSgKKwy6Q6cVWEhyAKMEVgLa1Md25b49hu5TAkkzZgZhL6RXEzgHp6EyVaV7mNZFS?cluster=devnet) |
| **(f) HTTP `x402` Fake-Mint Attack Rejected** | Real `Receipt` PDA settled via worthless `FakeMint` Vault rejected with `HTTP 402` (`Mint mismatch`) | [View Tx (`5N587Ups...`)](https://explorer.solana.com/tx/5N587Ups9497y8zrMKeounu7cqgL1PCEPC1X24MLmexGLzDSUD4USm7GqxKPs4aE3ioXtsRa4EzDxQrpuJzcdnJe?cluster=devnet) |
| **(g) HTTP `x402` Vault + Receipt Verified (`200 OK`)** | Dual `Vault.mint` + `Receipt` PDA (`EQSXaksd...`) verified -> `HTTP 200 OK` (and `402` on replay) | [View Tx (`4sBHU3fG...`)](https://explorer.solana.com/tx/4sBHU3fGz4PLXYqXJVapnzdUrqB6PGDyRnfDJ1eK7HT9LVd4GFShygfxWa6BxEXnzGCz7aVc781ijYvJmSfDuN6R?cluster=devnet) |

---

## 6. Deploying the Judge Sandbox to Vercel

1. Import `Johnlocke0347/leash-x402` in Vercel and set **Root Directory** to **`app`**.
2. Configure environment variables (see [`app/.env.example`](./app/.env.example)):
   - `NEXT_PUBLIC_SOLANA_RPC_URL` — Public Devnet RPC URL (e.g., Helius/Triton Devnet URL or `https://api.devnet.solana.com`).
   - `SOLANA_RPC_URL` — Server-side Devnet RPC URL used by `/api/x402/resource` and `/api/faucet`.
   - `EXPECTED_MINT` — Default enforced SPL mint (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` for Devnet USDC).
   - `ALLOW_SANDBOX_MOCK_MINT` — Set to `"true"` on Judge Sandbox previews so browser-minted MockUSDC vaults are accepted.
   - `FAUCET_SECRET_KEY` *(optional, server-only — never `NEXT_PUBLIC_`)* — JSON 64-byte array or base58 secret key of a Devnet SOL wallet to auto-drip `0.05 SOL` during Step 1 (`< 0.04 SOL` total setup + agent stipend). If omitted, `/api/faucet` returns `HTTP 503` and the UI falls back cleanly to `requestAirdrop` and `https://faucet.solana.com`.

---

## 7. Local Run Instructions (3 Commands)

```bash
# 1. Install root dependencies and run the 12-case localnet adversarial exploit suite
npm install && anchor test

# 2. Install and build the standalone Next.js Judge Sandbox + x402 Receipt verifier API
npm install --prefix app && npm run build --prefix app

# 3. Launch the Judge Sandbox UI at http://localhost:3000
ALLOW_SANDBOX_MOCK_MINT=true npm run dev --prefix app
```

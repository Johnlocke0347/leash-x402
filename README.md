# Leash — Payer-Side Spending Control Plane & Prompt-Injection Circuit Breaker for Solana `x402`

Leash is a non-custodial Solana Anchor protocol that isolates autonomous agent hot keys (`x402` / `Pay.sh`) from treasury custody. A human or multisig **Vault Owner** deposits SPL liquidity into a PDA-controlled vault and issues bounded **Session** mandates to ephemeral **Agent Signers**. Any policy violation commits an irreversible on-chain circuit-breaker trip (`SessionStatus::Tripped`) while transferring **zero** tokens.

- **Deployed Solana Devnet Program ID:** [`Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH`](https://explorer.solana.com/address/Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH?cluster=devnet)
- **Devnet Deploy Transaction:** [`FzaMmyRUyrxWu7EP4Erzkj2yVpKXC1y1aKEywsEZACReDLU9r9ipd1T6MYa6Q55QYr8iMh2kMtC5XcRbLExtXoc`](https://explorer.solana.com/tx/FzaMmyRUyrxWu7EP4Erzkj2yVpKXC1y1aKEywsEZACReDLU9r9ipd1T6MYa6Q55QYr8iMh2kMtC5XcRbLExtXoc?cluster=devnet)
- **On-Chain IDL Account:** [`F4kiQFPBNQ4EYHacVLVRB8g5AT54p7WdwiQtZWo1vuYG`](https://explorer.solana.com/address/F4kiQFPBNQ4EYHacVLVRB8g5AT54p7WdwiQtZWo1vuYG?cluster=devnet)

---

## 1. Threat Model

Autonomous agents executing HTTP `402 Payment Required` workflows hold hot signing keys in untrusted runtime environments exposed to indirect prompt injection, malicious tool responses, and compromised upstream APIs:

| Attack Vector | On-Chain Defense in Leash |
| :--- | :--- |
| **Prompt-Injection Vault Drain** (`amount > max_per_tx`) | Soft-trips session (`TripReason::ExceedsPerTxMax`), moves `0` tokens, allocates `0` receipt rent, permanently locks session. |
| **Salami-Slicing Retry After Trip** | Terminal gate: once `status != Active`, every subsequent `execute_agent_spend` (even `1` base unit) hard-reverts with `VaultError::SessionNotActive`. |
| **Exfiltration to Rogue Merchant / Spoofed ATA** | Enforces owner-curated `allowlist` (max 16 unique pubkeys) AND verifies `merchant_ata.owner == merchant`, `merchant_ata.mint == vault.mint`, and `merchant_ata.delegate.is_none()`. |
| **2x Boundary Burst Rate-Limit Bypass** | Continuous `u128` linear leaky-bucket refill eliminates fixed/tumbling window boundary resets. |
| **Non-Reverting `x402` Settlement Spoofing** | Canonical `Receipt` PDA is allocated **only** on the passing settlement path; resource servers verify the `Receipt` PDA on-chain rather than `tx.meta.err == null`. |
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

## 4. Closing the Non-Reverting `x402` Verification Trap

On Solana, if an instruction returns `Err(...)`, the runtime rolls back **all** state mutations—making it impossible to persist `session.status = SessionStatus::Tripped` on-chain during a reverting transaction. Consequently, Leash's policy-violation branch mutates `Session` to `Tripped`, emits `CircuitBreakerTripped`, transfers `0` tokens, and returns `Ok(())` (`tx.meta.err == null`).

A naive `x402` resource server that only checks `tx.meta.err == null` would be tricked into serving paid data on a `0`-token circuit-breaker trip. Leash eliminates this trap:
- `ExecuteAgentSpend` takes `receipt` as an `UncheckedAccount` verified against canonical seeds `[b"receipt", vault.key().as_ref(), &request_hash]`.
- On any policy failure, `execute_agent_spend` returns `Ok(())` **without** creating or initializing the `Receipt` account.
- Only when all 7 policy checks and SPL `transfer_checked` succeed does the program allocate and serialize the `Receipt` discriminator + payload.
- Resource servers (`/api/x402/resource`) verify the on-chain `Receipt` PDA directly (owner, discriminator, canonical bump, `vault`, `merchant`, `amount`, `request_hash`, and `clock.slot < expiry_slot`).

---

## 5. Live Solana Devnet Verification Proof Links

Full details and public keys are recorded in [`DEVNET_PROOF.md`](./DEVNET_PROOF.md):

| Verification Flow | On-Chain / HTTP Outcome | Solana Devnet Explorer Link |
| :--- | :--- | :--- |
| **(a) Normal Spend + Receipt Verification** | Settled `250,000` MockUSDC; created `Receipt` PDA (`2cSiWMAVNiNZyGSeXXcanqpvSF4SCSukY69araoSp4xh`) | [View Tx (`4SghwCco...`)](https://explorer.solana.com/tx/4SghwCcogY9QF4as2UJ9AVk6dm3MQEChPJSbTZNA491YydJDe8VNNQhWjmQk4XLvSDZueCpBxdiPTTV5iZ2MEG3Q?cluster=devnet) |
| **(b) Prompt-Injection Drain Trip** | `Ok(())`, **0 tokens moved**, no `Receipt` PDA, `Tripped (ExceedsPerTxMax)` | [View Tx (`2BMpcD3V...`)](https://explorer.solana.com/tx/2BMpcD3V28hGN6PngMG3y5zKjQzHYLCUpVMgh7r9wvaLxzwfJPgTgtp3jjzs2dFwUTcsaQyBRWjNXMkrebPRBByg?cluster=devnet) |
| **(c) Salami Retry Hard-Revert** | `100` unit retry hard-reverted on-chain (`Custom(6010) / SessionNotActive`) | [View Tx (`8kdt5Vr9...`)](https://explorer.solana.com/tx/8kdt5Vr9Rv5GR9HSNQT1pGutxHVVi7yoE6414Z3jm2WRM1oGiejDXeKVoqn3FmX4yzZxSkxnWEYXHaLyrcxZtZL?cluster=devnet) |
| **(d) Permissionless Reap Session** | Third-party keeper closed `Session` PDA & returned full rent to `vault.owner` | [View Tx (`5ihDcDsr...`)](https://explorer.solana.com/tx/5ihDcDsrCvppfHVuVoxnQXi1Wzc3ktzSA4DsxAtWTW9hV49hZ7Eq1ypw9qi4Bmue1ccXX3mPncx23F3zcEW5YV1X?cluster=devnet) |
| **(e) Live HTTP `x402` Tripped Bypass Rejected** | Non-reverting tripped tx (`meta.err == null`) rejected by `/api/x402/resource` with `HTTP 402` | [View Tx (`3pEuKA4v...`)](https://explorer.solana.com/tx/3pEuKA4vnhHR1r5puPk7oWby3nXJr2YysXwZas7eCC1foupy8qomi96mJ5UjwNnf8jgZshMXQEhHYt2sNdbKL7wV?cluster=devnet) |
| **(f) Live HTTP `x402` Receipt Verified (`200 OK`)** | `/api/x402/resource` verified `Receipt` PDA (`3vN531QXPZwf9B4CzWajnJnD3S4P4qLgEpWpF28w4aF7`) -> `HTTP 200 OK` | [View Tx (`2SYVixyv...`)](https://explorer.solana.com/tx/2SYVixyvj4m4HarKHD6RgK2VU49aPGU1ZsbRhVXBD69wWSW8KKrw4EZHsgEH2tvvnnUqutCSbZ2Bz1L6vVDwsVgG?cluster=devnet) |

---

## 6. Local Run Instructions (3 Commands)

```bash
# 1. Install root dependencies and run the 12-case localnet adversarial exploit suite
npm install && anchor test

# 2. Install and build the standalone Next.js Judge Sandbox + x402 Receipt verifier API
npm install --prefix app && npm run build --prefix app

# 3. Launch the Judge Sandbox UI at http://localhost:3000
npm run dev --prefix app
```

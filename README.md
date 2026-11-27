# Leash — Payer-Side Spending Control Plane & Prompt-Injection Circuit Breaker for Solana `x402`

Leash is a non-custodial Solana Anchor protocol that isolates autonomous agent hot keys (`x402` / `Pay.sh`) from treasury custody. A human or multisig **Vault Owner** deposits SPL liquidity into a PDA-controlled vault and issues bounded **Session** mandates to ephemeral **Agent Signers**. Any policy violation commits an irreversible on-chain circuit-breaker trip (`SessionStatus::Tripped`) while transferring **zero** tokens.

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
| **Vault Owner SOL Fee-Griefing & State Bloat** | `agent_signer` signs and pays tx fees + `Receipt` rent; expired `Receipt` and idle/tripped `Session` PDAs are permissionlessly reapable back to their original rent payers. |
| **Global Emergency Incident** | `set_pause(true)` trips any active agent spend (`VaultPaused`) while `owner_withdraw` remains live at all times. |

---

## 2. Canonical PDA Architecture

Program ID (pre-synced across `Anchor.toml`, `programs/leash/src/lib.rs`, and `app/`):  
`Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH`

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
- Only when all 7 policy checks and SPL `transfer_checked` succeed does the program invoke `system_program::create_account` and serialize the `Receipt` discriminator + payload.
- Resource servers (`/api/x402/resource`) verify the on-chain `Receipt` PDA directly (owner, discriminator, canonical bump, `vault`, `merchant`, `amount`, `request_hash`, and `clock.slot < expiry_slot`).

---

## 5. Devnet Deployment Status & 1-Command Deploy

- **Current Status:** `PENDING_FUNDING` (public `api.devnet.solana.com` returned `HTTP 410` rate-limit on headless datacenter airdrop).
- **Pre-Synced Program ID:** `Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH` (`321,152` bytes; rent-exempt deploy minimum `1.6321024 SOL`).
- **Deployer / Vault Owner Pubkey:** `2SLiJHDx9SmJn4TLKJuDAPoH1T2QLviD5giXTnmXoifB`
- **Agent Signer Pubkey:** `GENRkS5amj5APxHyCrUEG6RpNq6esotQAhE31ipj8TSk`

To deploy to Solana Devnet and automatically populate [`DEVNET_PROOF.md`](./DEVNET_PROOF.md) with live Solana Explorer proof links for all 4 adversarial scenarios (Normal Spend + Receipt, Drain Trip, Salami Hard-Revert, Permissionless Reap):

1. Send **4 Devnet SOL** to `2SLiJHDx9SmJn4TLKJuDAPoH1T2QLviD5giXTnmXoifB` at [https://faucet.solana.com](https://faucet.solana.com).
2. Run:
   ```bash
   ./scripts/deploy-devnet.sh
   ```

See [`DEVNET_PROOF.md`](./DEVNET_PROOF.md) for recorded public keys and verification table.

---

## 6. Local Run Instructions (3 Commands)

```bash
# 1. Install root dependencies and run the 11-case localnet adversarial exploit suite
npm install && anchor test

# 2. Install and build the standalone Next.js Judge Sandbox + x402 Receipt verifier API
npm install --prefix app && npm run build --prefix app

# 3. Launch the Judge Sandbox UI at http://localhost:3000
npm run dev --prefix app
```

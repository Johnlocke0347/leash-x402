# Leash Protocol Specification (`SPEC.md`)

**Status:** Locked (Phase 1)  
**Target Cluster:** Solana Localnet & Devnet  
**Framework:** Anchor `0.32.3` (`solana-cli 4.1.2`)

Leash is a non-custodial, payer-side spending control plane and on-chain prompt-injection circuit breaker for Solana `x402` / `Pay.sh` autonomous agents. Vault owners retain full custody and emergency withdrawal rights over SPL liquidity while delegating tightly bounded, rate-limited spending sessions to ephemeral agent signers.

---

## 1. Threat Model & Design Goals

1. **Prompt-Injection Drain Defense:** A compromised or hallucinating autonomous agent attempting to drain the vault (`amount > max_per_tx`, unallowlisted merchant, spoofed/delegated merchant ATA, rate-spike, or lifetime budget exhaustion) triggers an immediate, **permanent** on-chain state transition (`SessionStatus::Tripped`) in a non-reverting transaction (`Ok(())`) while transferring **zero** tokens and allocating **zero** receipt rent.
2. **Anti-Salami-Slicing:** Once a `Session` enters `Tripped` (or `Revoked`), there is **zero recovery path**. Any subsequent `execute_agent_spend` call—even for `1` base unit—immediately hard-reverts with `VaultError::SessionNotActive`.
3. **Continuous Leaky-Bucket Rate Limiting:** Fixed/tumbling windows allow `2x` burst boundary exploits (`100%` at `T - ε` + `100%` at `T + ε`). Leash enforces continuous linear refill using checked `u128` arithmetic.
4. **Closing the Non-Reverting `x402` Verification Trap:** Because policy-violating calls intentionally return `Ok(())` to persist `SessionStatus::Tripped` on-chain, naive `x402` resource servers that only check `tx.meta.err == null` would erroneously serve paid resources on tripped transactions. Leash solves this by initializing a canonical **`Receipt` PDA** *only* on the passing settlement path. Resource servers verify the on-chain `Receipt` PDA directly.
5. **Anti-Fee-Griefing & Zero State Bloat:** `agent_signer` signs and pays transaction fees and `Receipt` PDA rent. Expired `Receipt` PDAs and idle/tripped/revoked `Session` PDAs are permissionlessly reapable back to their original rent payers (`agent_signer` and `vault.owner`, respectively).

---

## 2. Accounts & Canonical PDAs

All accounts include Anchor's 8-byte discriminator.

### 2.1 `Vault`
- **Seeds:** `[b"vault", owner.key().as_ref()]`
- **Max Space:** `8 + 32 + 32 + 32 + 1 + 8 + (4 + 16 * 32) + 1 = 630` bytes

| Field | Type | Description |
| :--- | :--- | :--- |
| `owner` | `Pubkey` | Cold/human authority controlling policy, pause, sessions, and withdrawals |
| `mint` | `Pubkey` | SPL Token mint governed by this vault (e.g., USDC) |
| `vault_ata` | `Pubkey` | Canonical SPL Associated Token Account owned by the `Vault` PDA |
| `paused` | `bool` | Global emergency circuit-breaker flag for agent spends |
| `session_nonce` | `u64` | Monotonically increasing counter for deterministic `Session` PDAs |
| `allowlist` | `Vec<Pubkey>` | Up to 16 unique approved merchant wallet pubkeys |
| `bump` | `u8` | Canonical PDA bump |

### 2.2 `Session`
- **Seeds:** `[b"session", vault.key().as_ref(), &nonce.to_le_bytes()]`
- **Space:** `8 + 32 + 32 + (10 * 8) + 1 + 1 + 1 = 155` bytes

| Field | Type | Description |
| :--- | :--- | :--- |
| `vault` | `Pubkey` | Parent `Vault` PDA |
| `agent_signer` | `Pubkey` | Hot keypair authorized to execute bounded spends and pay tx/receipt fees |
| `nonce` | `u64` | Vault `session_nonce` at creation time |
| `max_per_tx` | `u64` | Maximum SPL base units permitted in a single transaction |
| `bucket_cap` | `u64` | Maximum burst capacity of the leaky bucket |
| `bucket_tokens` | `u64` | Remaining tokens in the leaky bucket as of `last_refill_ts` |
| `window_secs` | `u64` | Seconds required for the leaky bucket to refill `bucket_cap` tokens |
| `last_refill_ts` | `i64` | Unix timestamp of the last bucket refill calculation |
| `lifetime_cap` | `u64` | Cumulative maximum SPL base units allowed across the session's lifetime |
| `lifetime_spent` | `u64` | Cumulative SPL base units settled by this session |
| `idle_timeout_secs` | `i64` | Maximum allowed inactivity window (seconds) before expiration |
| `last_active_ts` | `i64` | Unix timestamp of session creation or most recent settled spend |
| `status` | `SessionStatus` | `Active` \| `Tripped` \| `Revoked` |
| `trip_reason` | `TripReason` | `None` \| `VaultPaused` \| `MerchantNotAllowlisted` \| `ExceedsPerTxMax` \| `ExceedsRateBucket` \| `ExceedsLifetimeCap` \| `SessionIdleExpired` \| `InvalidMerchantAta` |
| `bump` | `u8` | Canonical PDA bump |

### 2.3 `Receipt`
- **Seeds:** `[b"receipt", vault.key().as_ref(), &request_hash]`
- **Space:** `8 + 32 + 32 + 32 + 8 + 32 + 8 + 32 + 1 = 185` bytes

| Field | Type | Description |
| :--- | :--- | :--- |
| `vault` | `Pubkey` | `Vault` PDA from which funds were settled |
| `session` | `Pubkey` | `Session` PDA that authorized the spend |
| `merchant` | `Pubkey` | Verified allowlisted merchant wallet |
| `amount` | `u64` | Exact SPL base units transferred |
| `request_hash` | `[u8; 32]` | Deterministic `x402` challenge digest (`sha256(method\|path\|merchant\|amount\|nonce)`) |
| `expiry_slot` | `u64` | Slot at or after which the `Receipt` may be permissionlessly closed |
| `rent_payer` | `Pubkey` | `agent_signer` who funded receipt rent (receives rent back on close) |
| `bump` | `u8` | Canonical PDA bump |

---

## 3. Enums, Events & Errors

### 3.1 `SessionStatus`
- `Active`
- `Tripped`
- `Revoked`

### 3.2 `TripReason`
- `None`
- `VaultPaused`
- `MerchantNotAllowlisted`
- `ExceedsPerTxMax`
- `ExceedsRateBucket`
- `ExceedsLifetimeCap`
- `SessionIdleExpired`
- `InvalidMerchantAta`

### 3.3 Events
- `CircuitBreakerTripped { vault: Pubkey, session: Pubkey, reason: TripReason, attempted_amount: u64, merchant: Pubkey, ts: i64 }`
- `SpendSettled { vault: Pubkey, session: Pubkey, merchant: Pubkey, amount: u64, request_hash: [u8; 32], expiry_slot: u64 }`

### 3.4 Errors (`VaultError`)
- `AllowlistTooLarge` — Allowlist exceeds 16 pubkeys.
- `DuplicateAllowlistEntry` — Allowlist contains duplicate merchant pubkeys.
- `Unauthorized` — Signer is not `vault.owner`.
- `UnauthorizedAgent` — Signer is not `session.agent_signer`.
- `InvalidMint` — Mint account or argument does not match `vault.mint`.
- `InvalidVaultAta` — Vault token account does not match `vault.vault_ata`, `vault` owner, or `vault.mint`.
- `VaultMismatch` — `session.vault` does not match `vault.key()`.
- `InvalidSessionConfig` — Caps, window, timeout, or agent pubkey are zero/invalid.
- `InvalidReceiptTtl` — `receipt_ttl_slots == 0`.
- `ReceiptAlreadyExists` — Replay detected: `Receipt` PDA for `request_hash` is already initialized.
- `SessionNotActive` — `session.status != SessionStatus::Active` (terminal hard-revert).
- `SessionStillActive` — Attempted `reap_idle_session` on an active, non-idle session.
- `ReceiptNotExpired` — Attempted `close_expired_receipt` while `clock.slot < receipt.expiry_slot`.
- `InvalidRentRecipient` — Rent recipient does not match `vault.owner` (session reap) or `receipt.rent_payer` (receipt close).
- `InvalidWithdrawAmount` — Withdrawal amount must be `> 0`.
- `MathOverflow` — Checked arithmetic overflow/underflow.

---

## 4. Instructions & Exact Invariants

### 4.1 `init_vault(mint: Pubkey, initial_allowlist: Vec<Pubkey>)`
- Initializes `Vault` PDA `[b"vault", owner.key().as_ref()]` and SPL `vault_ata` (`associated_token::mint = mint`, `associated_token::authority = vault`).
- Enforces `mint == ctx.accounts.mint.key()`, `initial_allowlist.len() <= 16`, and strict uniqueness across `initial_allowlist`.
- Sets `paused = false`, `session_nonce = 0`.

### 4.2 `update_allowlist(new_allowlist: Vec<Pubkey>)`
- Requires `owner` signer (`vault.owner == owner.key()`).
- Enforces `new_allowlist.len() <= 16` and strict deduplication.

### 4.3 `set_pause(paused: bool)`
- Requires `owner` signer (`vault.owner == owner.key()`).
- Updates `vault.paused = paused`.

### 4.4 `create_session(agent_signer: Pubkey, max_per_tx: u64, bucket_cap: u64, window_secs: u64, lifetime_cap: u64, idle_timeout_secs: i64)`
- Requires `owner` signer (`vault.owner == owner.key()`).
- Validates `agent_signer != Pubkey::default()`, `max_per_tx > 0`, `bucket_cap > 0`, `window_secs > 0`, `lifetime_cap > 0`, and `idle_timeout_secs > 0`.
- Initializes `Session` PDA `[b"session", vault.key().as_ref(), &vault.session_nonce.to_le_bytes()]` with `bucket_tokens = bucket_cap`, `last_refill_ts = now`, `last_active_ts = now`, `lifetime_spent = 0`, `status = SessionStatus::Active`, `trip_reason = TripReason::None`.
- Increments `vault.session_nonce` via `checked_add(1)`.

### 4.5 `execute_agent_spend(amount: u64, request_hash: [u8; 32], receipt_ttl_slots: u64)`
1. **Signer & Fee Payer:** `agent_signer` MUST sign and pay transaction fees and `Receipt` PDA rent.
2. **Structural Invariants (Hard Revert on Failure):**
   - `session.vault == vault.key()`
   - `session.agent_signer == agent_signer.key()`
   - `mint.key() == vault.mint`
   - `vault_ata.key() == vault.vault_ata`
   - `vault_ata.owner == vault.key()`
   - `vault_ata.mint == vault.mint`
   - `receipt_ttl_slots > 0`
   - `receipt` matches PDA `[b"receipt", vault.key().as_ref(), &request_hash]` and is uninitialized (`receipt.data_is_empty() && receipt.owner == &system_program::ID`).
3. **Active Gate (Hard Revert):**
   - If `session.status != SessionStatus::Active`, immediately return `Err(VaultError::SessionNotActive.into())`.
4. **Checked `u128` Leaky-Bucket Refill:**
   - `elapsed = max(0, now.checked_sub(session.last_refill_ts)?) as u128`
   - `refill = elapsed.checked_mul(session.bucket_cap as u128)?.checked_div(session.window_secs as u128)?`
   - `available_tokens = min(session.bucket_cap as u128, (session.bucket_tokens as u128).checked_add(refill)?) as u64`
5. **Deterministic Policy Evaluation Order:**
   1. `!vault.paused` -> else `TripReason::VaultPaused`
   2. `now.checked_sub(session.last_active_ts)? <= session.idle_timeout_secs` -> else `TripReason::SessionIdleExpired`
   3. `vault.allowlist.contains(&merchant.key())` -> else `TripReason::MerchantNotAllowlisted`
   4. `merchant_ata.mint == vault.mint && merchant_ata.owner == merchant.key() && merchant_ata.delegate.is_none()` -> else `TripReason::InvalidMerchantAta`
   5. `amount > 0 && amount <= session.max_per_tx` -> else `TripReason::ExceedsPerTxMax`
   6. `amount <= available_tokens` -> else `TripReason::ExceedsRateBucket`
   7. `session.lifetime_spent.checked_add(amount).map_or(false, |t| t <= session.lifetime_cap)` -> else `TripReason::ExceedsLifetimeCap`
6. **Failure Path (Soft-Trip Commit):**
   - Transfers **zero** SPL tokens.
   - Does **not** allocate or initialize `Receipt` (`UncheckedAccount` remains unallocated).
   - Sets `session.status = SessionStatus::Tripped` and `session.trip_reason = reason`.
   - Emits `CircuitBreakerTripped { vault, session, reason, attempted_amount, merchant, ts }`.
   - Returns `Ok(())` so the tripped state persists permanently on-chain.
7. **Passing Path (Settlement & Receipt Initialization):**
   - Executes SPL `transfer_checked` signed by `Vault` PDA seeds from `vault_ata` to `merchant_ata`.
   - Updates `session.bucket_tokens = available_tokens.checked_sub(amount)?`, `session.last_refill_ts = now`, `session.lifetime_spent = session.lifetime_spent.checked_add(amount)?`, `session.last_active_ts = now`.
   - Allocates and initializes `Receipt` PDA via `system_program::create_account` (with dust-prefund fallback) + Anchor discriminator serialization (`expiry_slot = clock.slot.checked_add(receipt_ttl_slots)?`, `rent_payer = agent_signer.key()`).
   - Emits `SpendSettled { vault, session, merchant, amount, request_hash, expiry_slot }`.
   - Returns `Ok(())`.

### 4.6 `revoke_session()`
- Requires `owner` signer (`vault.owner == owner.key()`) and `session.vault == vault.key()`.
- Sets `session.status = SessionStatus::Revoked`.

### 4.7 `reap_idle_session()`
- Permissionless caller.
- Requires `session.status != SessionStatus::Active` OR `now.checked_sub(session.last_active_ts)? > session.idle_timeout_secs`.
- Requires `rent_recipient.key() == vault.owner`.
- Closes `Session` PDA and transfers all rent lamports directly to `rent_recipient`.

### 4.8 `close_expired_receipt()`
- Permissionless caller.
- Requires `clock.slot >= receipt.expiry_slot` and `rent_recipient.key() == receipt.rent_payer`.
- Closes `Receipt` PDA and transfers all rent lamports directly to `rent_recipient`.

### 4.9 `owner_withdraw(amount: u64)`
- Requires `owner` signer (`vault.owner == owner.key()`).
- Transfers `amount` (`> 0`) SPL tokens via `transfer_checked` from `vault_ata` to `owner_ata` signed by `Vault` PDA seeds, **regardless of `vault.paused`**.

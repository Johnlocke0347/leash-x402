# Devnet Deployment & Verification Proof (`DEVNET_PROOF.md`)

**Deployment Status:** `PENDING_FUNDING`  
**Cluster:** Solana Devnet (`https://api.devnet.solana.com`)  
**Pre-Synced Deterministic Program ID:** `Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH`  
**Compiled Binary Size (`target/deploy/leash.so`):** `321,152` bytes (Rent-exempt minimum: `1.6321024 SOL`)

---

## 1. Ephemeral Devnet Public Keys (Secrets Excluded via `.gitignore`)

| Role | Keypair Location (Local / Untracked) | Public Key |
| :--- | :--- | :--- |
| **Owner + Deployer** | `.devnet-keys/owner-devnet.json` | `2SLiJHDx9SmJn4TLKJuDAPoH1T2QLviD5giXTnmXoifB` |
| **Agent Signer** | `.devnet-keys/agent-devnet.json` | `GENRkS5amj5APxHyCrUEG6RpNq6esotQAhE31ipj8TSk` |

> **Why `PENDING_FUNDING`:** Public `https://api.devnet.solana.com` returned `HTTP 410` (`x-ratelimit-endpoint-remaining: -7421`) on `requestAirdrop` from cloud datacenter egress. Both keypairs and the deterministic program keypair (`Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH`) remain persisted inside this sandbox and synced across `Anchor.toml`, `programs/leash/src/lib.rs`, and `app/`.

---

## 2. One-Command Devnet Deploy & Smoke Verification

1. Send **4 Devnet SOL** to the Owner/Deployer pubkey `2SLiJHDx9SmJn4TLKJuDAPoH1T2QLviD5giXTnmXoifB` via [https://faucet.solana.com](https://faucet.solana.com).
2. Run the single automated deploy + adversarial smoke script:

```bash
./scripts/deploy-devnet.sh
```

`./scripts/deploy-devnet.sh` automatically:
1. Transfers `0.5 SOL` from `owner-devnet.json` to `agent-devnet.json` (`GENRkS5amj5APxHyCrUEG6RpNq6esotQAhE31ipj8TSk`).
2. Deploys `target/deploy/leash.so` to Solana Devnet at `Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH` (syncing IDs automatically if a custom program keypair is used).
3. Executes `scripts/devnet-smoke.ts` on live Devnet and overwrites Section 3 below with live Solana Explorer links.

---

## 3. On-Chain Devnet Proof Transactions

| Scenario | Expected On-Chain Outcome | Devnet Explorer Link |
| :--- | :--- | :--- |
| **(a) Normal Spend + Receipt Verification** | Transfers `250,000` MockUSDC, initializes canonical `Receipt` PDA | `PENDING_FUNDING` (populated automatically by `./scripts/deploy-devnet.sh`) |
| **(b) Prompt-Injection Drain Trip** | Returns `Ok(())`, **0 tokens moved**, no `Receipt` PDA, `status = Tripped (ExceedsPerTxMax)` | `PENDING_FUNDING` (populated automatically by `./scripts/deploy-devnet.sh`) |
| **(c) Salami Retry Hard-Revert** | Subsequent `100` unit spend hard-reverts on-chain with `SessionNotActive` (`0x177a`) | `PENDING_FUNDING` (populated automatically by `./scripts/deploy-devnet.sh`) |
| **(d) Permissionless Reap Idle / Tripped Session** | Third-party keeper closes `Session` PDA and returns full rent to `owner` | `PENDING_FUNDING` (populated automatically by `./scripts/deploy-devnet.sh`) |

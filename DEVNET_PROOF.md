# Devnet Deployment & Verification Proof (`DEVNET_PROOF.md`)

**Deployment Status:** `DEPLOYED_AND_VERIFIED`  
**Cluster:** Solana Devnet (`https://api.devnet.solana.com`)  
**Deployed Program ID:** [`Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH`](https://explorer.solana.com/address/Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH?cluster=devnet)  
**Deploy Transaction:** [https://explorer.solana.com/tx/FzaMmyRUyrxWu7EP4Erzkj2yVpKXC1y1aKEywsEZACReDLU9r9ipd1T6MYa6Q55QYr8iMh2kMtC5XcRbLExtXoc?cluster=devnet](https://explorer.solana.com/tx/FzaMmyRUyrxWu7EP4Erzkj2yVpKXC1y1aKEywsEZACReDLU9r9ipd1T6MYa6Q55QYr8iMh2kMtC5XcRbLExtXoc?cluster=devnet)  
**Published On-Chain IDL Account:** [`F4kiQFPBNQ4EYHacVLVRB8g5AT54p7WdwiQtZWo1vuYG`](https://explorer.solana.com/address/F4kiQFPBNQ4EYHacVLVRB8g5AT54p7WdwiQtZWo1vuYG?cluster=devnet)

---

## 1. Ephemeral Devnet Public Keys (Secrets Excluded via `.gitignore`)

| Role | Keypair Location (Local / Untracked) | Public Key |
| :--- | :--- | :--- |
| **Owner + Deployer** | `.devnet-keys/owner-devnet.json` | `2SLiJHDx9SmJn4TLKJuDAPoH1T2QLviD5giXTnmXoifB` |
| **Agent Signer** | `.devnet-keys/agent-devnet.json` | `GENRkS5amj5APxHyCrUEG6RpNq6esotQAhE31ipj8TSk` |
| **Vault PDA** | Derived `["vault", owner]` | `DG2cUe431n9y9Nk7mmZi1mZtwUo2FNPa1rzHSHthKhuG` |
| **Canonical x402 Merchant** | Derived `["x402-merchant-v1"]` | `3z2aLExr6Em1A1ufnoFfe1PSZro8ue9oJ4abs7tJquWV` |
| **MockUSDC Mint** | SPL Token Mint (6 decimals) | `6PwHwMffYf3JxJHjxETbkQTUaoK7Qva8ttMGNXRfRLm5` |

---

## 2. On-Chain Devnet Smoke Proof Transactions (`scripts/devnet-smoke.ts`)

| Scenario | Verified On-Chain Outcome | Devnet Explorer Link |
| :--- | :--- | :--- |
| **(a) Normal Spend + Receipt Verification** | Transferred `250,000` MockUSDC; verified canonical `Receipt` PDA (`2cSiWMAVNiNZyGSeXXcanqpvSF4SCSukY69araoSp4xh`) | [https://explorer.solana.com/tx/4SghwCcogY9QF4as2UJ9AVk6dm3MQEChPJSbTZNA491YydJDe8VNNQhWjmQk4XLvSDZueCpBxdiPTTV5iZ2MEG3Q?cluster=devnet](https://explorer.solana.com/tx/4SghwCcogY9QF4as2UJ9AVk6dm3MQEChPJSbTZNA491YydJDe8VNNQhWjmQk4XLvSDZueCpBxdiPTTV5iZ2MEG3Q?cluster=devnet) |
| **(b) Prompt-Injection Drain Trip** | Returned `Ok(())`, **0 tokens moved**, no `Receipt` PDA, `status = Tripped (ExceedsPerTxMax)` | [https://explorer.solana.com/tx/2BMpcD3V28hGN6PngMG3y5zKjQzHYLCUpVMgh7r9wvaLxzwfJPgTgtp3jjzs2dFwUTcsaQyBRWjNXMkrebPRBByg?cluster=devnet](https://explorer.solana.com/tx/2BMpcD3V28hGN6PngMG3y5zKjQzHYLCUpVMgh7r9wvaLxzwfJPgTgtp3jjzs2dFwUTcsaQyBRWjNXMkrebPRBByg?cluster=devnet) |
| **(c) Salami Retry Hard-Revert** | `100` unit follow-up spend hard-reverted on-chain (`Custom(6010) / SessionNotActive`) | [https://explorer.solana.com/tx/8kdt5Vr9Rv5GR9HSNQT1pGutxHVVi7yoE6414Z3jm2WRM1oGiejDXeKVoqn3FmX4yzZxSkxnWEYXHaLyrcxZtZL?cluster=devnet](https://explorer.solana.com/tx/8kdt5Vr9Rv5GR9HSNQT1pGutxHVVi7yoE6414Z3jm2WRM1oGiejDXeKVoqn3FmX4yzZxSkxnWEYXHaLyrcxZtZL?cluster=devnet) |
| **(d) Permissionless Reap Idle / Tripped Session** | Third-party keeper (`9cqmsq58PrtpQJ3BNq4wh4nwFD5R99CHoEk4AhUXAx4U`) closed `Session` PDA & returned full rent to `owner` | [https://explorer.solana.com/tx/5ihDcDsrCvppfHVuVoxnQXi1Wzc3ktzSA4DsxAtWTW9hV49hZ7Eq1ypw9qi4Bmue1ccXX3mPncx23F3zcEW5YV1X?cluster=devnet](https://explorer.solana.com/tx/5ihDcDsrCvppfHVuVoxnQXi1Wzc3ktzSA4DsxAtWTW9hV49hZ7Eq1ypw9qi4Bmue1ccXX3mPncx23F3zcEW5YV1X?cluster=devnet) |

---

## 3. End-to-End Live HTTP `/api/x402/resource` Proof (`scripts/verify-x402-e2e.ts`)

| HTTP Flow | Result | Devnet Explorer Link |
| :--- | :--- | :--- |
| **Unauthenticated `GET /api/x402/resource`** | `HTTP 402` challenge (`nonce = b9a981554c83dda2bd4cd8ec`) | — |
| **Retry with Soft-Tripped Devnet Tx (`meta.err == null`)** | Rejected with `HTTP 402` (Receipt PDA `9bs6RNvwDPHZRXSCqhGutnRzNiLAtWr4AEwDH3HqYk67` absent on-chain) | [https://explorer.solana.com/tx/3pEuKA4vnhHR1r5puPk7oWby3nXJr2YysXwZas7eCC1foupy8qomi96mJ5UjwNnf8jgZshMXQEhHYt2sNdbKL7wV?cluster=devnet](https://explorer.solana.com/tx/3pEuKA4vnhHR1r5puPk7oWby3nXJr2YysXwZas7eCC1foupy8qomi96mJ5UjwNnf8jgZshMXQEhHYt2sNdbKL7wV?cluster=devnet) |
| **Retry after Settled Devnet `execute_agent_spend`** | Verified canonical `Receipt` PDA (`3vN531QXPZwf9B4CzWajnJnD3S4P4qLgEpWpF28w4aF7`) -> `HTTP 200 OK` | [https://explorer.solana.com/tx/2SYVixyvj4m4HarKHD6RgK2VU49aPGU1ZsbRhVXBD69wWSW8KKrw4EZHsgEH2tvvnnUqutCSbZ2Bz1L6vVDwsVgG?cluster=devnet](https://explorer.solana.com/tx/2SYVixyvj4m4HarKHD6RgK2VU49aPGU1ZsbRhVXBD69wWSW8KKrw4EZHsgEH2tvvnnUqutCSbZ2Bz1L6vVDwsVgG?cluster=devnet) |

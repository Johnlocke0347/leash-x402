use anchor_lang::prelude::*;

pub const MAX_ALLOWLIST_LEN: usize = 16;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum SessionStatus {
    Active,
    Tripped,
    Revoked,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum TripReason {
    None,
    VaultPaused,
    MerchantNotAllowlisted,
    ExceedsPerTxMax,
    ExceedsRateBucket,
    ExceedsLifetimeCap,
    SessionIdleExpired,
    InvalidMerchantAta,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub vault_ata: Pubkey,
    pub paused: bool,
    pub session_nonce: u64,
    #[max_len(16)]
    pub allowlist: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub vault: Pubkey,
    pub agent_signer: Pubkey,
    pub nonce: u64,
    pub max_per_tx: u64,
    pub bucket_cap: u64,
    pub bucket_tokens: u64,
    pub window_secs: u64,
    pub last_refill_ts: i64,
    pub lifetime_cap: u64,
    pub lifetime_spent: u64,
    pub idle_timeout_secs: i64,
    pub last_active_ts: i64,
    pub status: SessionStatus,
    pub trip_reason: TripReason,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub request_hash: [u8; 32],
    pub expiry_slot: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const VAULT_SPACE: usize = match 8_usize.checked_add(Vault::INIT_SPACE) {
    Some(v) => v,
    None => 630,
};

pub const SESSION_SPACE: usize = match 8_usize.checked_add(Session::INIT_SPACE) {
    Some(v) => v,
    None => 155,
};

pub const RECEIPT_SPACE: usize = match 8_usize.checked_add(Receipt::INIT_SPACE) {
    Some(v) => v,
    None => 185,
};


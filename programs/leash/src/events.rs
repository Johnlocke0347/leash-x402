use anchor_lang::prelude::*;

use crate::state::TripReason;

#[event]
pub struct CircuitBreakerTripped {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub reason: TripReason,
    pub attempted_amount: u64,
    pub merchant: Pubkey,
    pub ts: i64,
}

#[event]
pub struct SpendSettled {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub request_hash: [u8; 32],
    pub expiry_slot: u64,
}

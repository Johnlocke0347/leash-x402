use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Allowlist exceeds maximum capacity of 16 merchants")]
    AllowlistTooLarge,
    #[msg("Allowlist contains duplicate merchant pubkeys")]
    DuplicateAllowlistEntry,
    #[msg("Unauthorized: signer is not vault owner")]
    Unauthorized,
    #[msg("Unauthorized: signer is not session agent_signer")]
    UnauthorizedAgent,
    #[msg("SPL mint does not match vault mint")]
    InvalidMint,
    #[msg("Vault token account invariant violated")]
    InvalidVaultAta,
    #[msg("Session does not belong to provided vault")]
    VaultMismatch,
    #[msg("Session parameters must be strictly positive and agent signer non-default")]
    InvalidSessionConfig,
    #[msg("Receipt TTL slots must be greater than zero")]
    InvalidReceiptTtl,
    #[msg("Receipt PDA already exists for this request_hash")]
    ReceiptAlreadyExists,
    #[msg("Session is not active; tripped or revoked sessions cannot execute spends")]
    SessionNotActive,
    #[msg("Session is still active and within idle timeout window")]
    SessionStillActive,
    #[msg("Receipt has not yet reached expiry_slot")]
    ReceiptNotExpired,
    #[msg("Rent recipient does not match authorized payer/owner")]
    InvalidRentRecipient,
    #[msg("Withdrawal amount must be greater than zero")]
    InvalidWithdrawAmount,
    #[msg("Checked arithmetic overflow or underflow")]
    MathOverflow,
}

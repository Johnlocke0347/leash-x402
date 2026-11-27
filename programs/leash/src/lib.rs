use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Allocate, Assign, CreateAccount, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod errors;
pub mod events;
pub mod state;

use errors::VaultError;
use events::{CircuitBreakerTripped, SpendSettled};
use state::{
    Receipt, Session, SessionStatus, TripReason, Vault, MAX_ALLOWLIST_LEN, RECEIPT_SPACE,
    SESSION_SPACE, VAULT_SPACE,
};

declare_id!("Gyka77keaTzBgPj12CrqEJFoZpZodjh1tzHeERAP9ZRH");

fn validate_allowlist(allowlist: &[Pubkey]) -> Result<()> {
    require!(
        allowlist.len() <= MAX_ALLOWLIST_LEN,
        VaultError::AllowlistTooLarge
    );

    let mut i: usize = 0;
    while i < allowlist.len() {
        let next = i.checked_add(1).ok_or(VaultError::MathOverflow)?;
        if let Some(key) = allowlist.get(i) {
            if let Some(tail) = allowlist.get(next..) {
                require!(!tail.contains(key), VaultError::DuplicateAllowlistEntry);
            }
        }
        i = next;
    }

    Ok(())
}

#[program]
pub mod leash {
    use super::*;

    pub fn init_vault(
        ctx: Context<InitVault>,
        mint: Pubkey,
        initial_allowlist: Vec<Pubkey>,
    ) -> Result<()> {
        require_keys_eq!(mint, ctx.accounts.mint.key(), VaultError::InvalidMint);
        validate_allowlist(&initial_allowlist)?;

        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.mint = ctx.accounts.mint.key();
        vault.vault_ata = ctx.accounts.vault_ata.key();
        vault.paused = false;
        vault.session_nonce = 0;
        vault.allowlist = initial_allowlist;
        vault.bump = ctx.bumps.vault;

        Ok(())
    }

    pub fn update_allowlist(
        ctx: Context<UpdateAllowlist>,
        new_allowlist: Vec<Pubkey>,
    ) -> Result<()> {
        validate_allowlist(&new_allowlist)?;
        ctx.accounts.vault.allowlist = new_allowlist;
        Ok(())
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        Ok(())
    }

    pub fn create_session(
        ctx: Context<CreateSession>,
        agent_signer: Pubkey,
        max_per_tx: u64,
        bucket_cap: u64,
        window_secs: u64,
        lifetime_cap: u64,
        idle_timeout_secs: i64,
    ) -> Result<()> {
        require!(
            agent_signer != Pubkey::default()
                && max_per_tx > 0
                && bucket_cap > 0
                && window_secs > 0
                && lifetime_cap > 0
                && idle_timeout_secs > 0,
            VaultError::InvalidSessionConfig
        );

        let now = Clock::get()?.unix_timestamp;
        let vault = &mut ctx.accounts.vault;
        let nonce = vault.session_nonce;
        let next_nonce = nonce.checked_add(1).ok_or(VaultError::MathOverflow)?;

        let session = &mut ctx.accounts.session;
        session.vault = vault.key();
        session.agent_signer = agent_signer;
        session.nonce = nonce;
        session.max_per_tx = max_per_tx;
        session.bucket_cap = bucket_cap;
        session.bucket_tokens = bucket_cap;
        session.window_secs = window_secs;
        session.last_refill_ts = now;
        session.lifetime_cap = lifetime_cap;
        session.lifetime_spent = 0;
        session.idle_timeout_secs = idle_timeout_secs;
        session.last_active_ts = now;
        session.status = SessionStatus::Active;
        session.trip_reason = TripReason::None;
        session.bump = ctx.bumps.session;

        vault.session_nonce = next_nonce;

        Ok(())
    }

    pub fn execute_agent_spend(
        ctx: Context<ExecuteAgentSpend>,
        amount: u64,
        request_hash: [u8; 32],
        receipt_ttl_slots: u64,
    ) -> Result<()> {
        // 1. Structural invariants (hard revert on failure)
        let vault_key = ctx.accounts.vault.key();
        let session_key = ctx.accounts.session.key();
        let agent_key = ctx.accounts.agent_signer.key();

        require_keys_eq!(
            ctx.accounts.session.vault,
            vault_key,
            VaultError::VaultMismatch
        );
        require_keys_eq!(
            ctx.accounts.session.agent_signer,
            agent_key,
            VaultError::UnauthorizedAgent
        );
        require_keys_eq!(
            ctx.accounts.mint.key(),
            ctx.accounts.vault.mint,
            VaultError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.vault_ata.key(),
            ctx.accounts.vault.vault_ata,
            VaultError::InvalidVaultAta
        );
        require_keys_eq!(
            ctx.accounts.vault_ata.owner,
            vault_key,
            VaultError::InvalidVaultAta
        );
        require_keys_eq!(
            ctx.accounts.vault_ata.mint,
            ctx.accounts.vault.mint,
            VaultError::InvalidVaultAta
        );
        require!(receipt_ttl_slots > 0, VaultError::InvalidReceiptTtl);
        require!(
            ctx.accounts.receipt.data_is_empty()
                && ctx.accounts.receipt.owner == &system_program::ID,
            VaultError::ReceiptAlreadyExists
        );

        // 2. Terminal status gate (hard revert; zero recovery path)
        if ctx.accounts.session.status != SessionStatus::Active {
            return Err(VaultError::SessionNotActive.into());
        }

        // 3. Checked u128 leaky-bucket refill
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let raw_elapsed = now
            .checked_sub(ctx.accounts.session.last_refill_ts)
            .ok_or(VaultError::MathOverflow)?;
        let elapsed = core::cmp::max(0_i64, raw_elapsed) as u128;

        let refill = elapsed
            .checked_mul(ctx.accounts.session.bucket_cap as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(ctx.accounts.session.window_secs as u128)
            .ok_or(VaultError::MathOverflow)?;

        let refilled_tokens = (ctx.accounts.session.bucket_tokens as u128)
            .checked_add(refill)
            .ok_or(VaultError::MathOverflow)?;

        let available_tokens =
            core::cmp::min(ctx.accounts.session.bucket_cap as u128, refilled_tokens) as u64;

        // 4. Deterministic policy evaluation order
        let idle_elapsed = now
            .checked_sub(ctx.accounts.session.last_active_ts)
            .ok_or(VaultError::MathOverflow)?;

        let merchant_key = ctx.accounts.merchant.key();
        let vault = &ctx.accounts.vault;
        let session = &ctx.accounts.session;
        let merchant_ata = &ctx.accounts.merchant_ata;

        let policy_failure: Option<TripReason> = if vault.paused {
            Some(TripReason::VaultPaused)
        } else if idle_elapsed > session.idle_timeout_secs {
            Some(TripReason::SessionIdleExpired)
        } else if !vault.allowlist.contains(&merchant_key) {
            Some(TripReason::MerchantNotAllowlisted)
        } else if merchant_ata.mint != vault.mint
            || merchant_ata.owner != merchant_key
            || !merchant_ata.delegate.is_none()
        {
            Some(TripReason::InvalidMerchantAta)
        } else if !(amount > 0 && amount <= session.max_per_tx) {
            Some(TripReason::ExceedsPerTxMax)
        } else if amount > available_tokens {
            Some(TripReason::ExceedsRateBucket)
        } else if !session
            .lifetime_spent
            .checked_add(amount)
            .map_or(false, |total| total <= session.lifetime_cap)
        {
            Some(TripReason::ExceedsLifetimeCap)
        } else {
            None
        };

        // 5. On ANY policy failure: 0 tokens moved, NO Receipt allocated, permanently trip session
        if let Some(reason) = policy_failure {
            let session_mut = &mut ctx.accounts.session;
            session_mut.status = SessionStatus::Tripped;
            session_mut.trip_reason = reason;

            emit!(CircuitBreakerTripped {
                vault: vault_key,
                session: session_key,
                reason,
                attempted_amount: amount,
                merchant: merchant_key,
                ts: now,
            });

            return Ok(());
        }

        // 6. All checks passed: settle SPL transfer_checked signed by Vault PDA
        let vault_owner = ctx.accounts.vault.owner;
        let vault_bump = ctx.accounts.vault.bump;
        let vault_seeds: &[&[u8]] = &[b"vault", vault_owner.as_ref(), &[vault_bump]];
        let vault_signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.merchant_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        // Update session state with checked math
        let new_bucket_tokens = available_tokens
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;
        let new_lifetime_spent = ctx
            .accounts
            .session
            .lifetime_spent
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        let expiry_slot = clock
            .slot
            .checked_add(receipt_ttl_slots)
            .ok_or(VaultError::MathOverflow)?;

        let session_mut = &mut ctx.accounts.session;
        session_mut.bucket_tokens = new_bucket_tokens;
        session_mut.last_refill_ts = now;
        session_mut.lifetime_spent = new_lifetime_spent;
        session_mut.last_active_ts = now;

        // Manually allocate & serialize Receipt PDA only on passing path
        let receipt_space = RECEIPT_SPACE;
        let rent_lamports = Rent::get()?.minimum_balance(receipt_space);
        let receipt_bump = ctx.bumps.receipt;
        let receipt_seeds: &[&[u8]] = &[
            b"receipt",
            vault_key.as_ref(),
            request_hash.as_ref(),
            &[receipt_bump],
        ];
        let receipt_signer_seeds: &[&[&[u8]]] = &[receipt_seeds];

        let existing_lamports = ctx.accounts.receipt.lamports();
        if existing_lamports == 0 {
            system_program::create_account(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    CreateAccount {
                        from: ctx.accounts.agent_signer.to_account_info(),
                        to: ctx.accounts.receipt.to_account_info(),
                    },
                    receipt_signer_seeds,
                ),
                rent_lamports,
                receipt_space as u64,
                &crate::ID,
            )?;
        } else {
            if existing_lamports < rent_lamports {
                let shortfall = rent_lamports
                    .checked_sub(existing_lamports)
                    .ok_or(VaultError::MathOverflow)?;
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        SolTransfer {
                            from: ctx.accounts.agent_signer.to_account_info(),
                            to: ctx.accounts.receipt.to_account_info(),
                        },
                    ),
                    shortfall,
                )?;
            }
            system_program::allocate(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Allocate {
                        account_to_allocate: ctx.accounts.receipt.to_account_info(),
                    },
                    receipt_signer_seeds,
                ),
                receipt_space as u64,
            )?;
            system_program::assign(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Assign {
                        account_to_assign: ctx.accounts.receipt.to_account_info(),
                    },
                    receipt_signer_seeds,
                ),
                &crate::ID,
            )?;
        }

        let receipt_record = Receipt {
            vault: vault_key,
            session: session_key,
            merchant: merchant_key,
            amount,
            request_hash,
            expiry_slot,
            rent_payer: agent_key,
            bump: receipt_bump,
        };

        let mut receipt_data = ctx.accounts.receipt.try_borrow_mut_data()?;
        let mut writer: &mut [u8] = &mut receipt_data;
        receipt_record.try_serialize(&mut writer)?;

        emit!(SpendSettled {
            vault: vault_key,
            session: session_key,
            merchant: merchant_key,
            amount,
            request_hash,
            expiry_slot,
        });

        Ok(())
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        ctx.accounts.session.status = SessionStatus::Revoked;
        Ok(())
    }

    pub fn reap_idle_session(ctx: Context<ReapIdleSession>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let idle_elapsed = now
            .checked_sub(ctx.accounts.session.last_active_ts)
            .ok_or(VaultError::MathOverflow)?;

        require!(
            ctx.accounts.session.status != SessionStatus::Active
                || idle_elapsed > ctx.accounts.session.idle_timeout_secs,
            VaultError::SessionStillActive
        );

        Ok(())
    }

    pub fn close_expired_receipt(ctx: Context<CloseExpiredReceipt>) -> Result<()> {
        let slot = Clock::get()?.slot;
        require!(
            slot >= ctx.accounts.receipt.expiry_slot,
            VaultError::ReceiptNotExpired
        );
        Ok(())
    }

    pub fn owner_withdraw(ctx: Context<OwnerWithdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidWithdrawAmount);

        let vault_owner = ctx.accounts.vault.owner;
        let vault_bump = ctx.accounts.vault.bump;
        let vault_seeds: &[&[u8]] = &[b"vault", vault_owner.as_ref(), &[vault_bump]];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = VAULT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAllowlist<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct CreateSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = owner,
        space = SESSION_SPACE,
        seeds = [b"session", vault.key().as_ref(), &vault.session_nonce.to_le_bytes()],
        bump,
    )]
    pub session: Account<'info, Session>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, request_hash: [u8; 32], receipt_ttl_slots: u64)]
pub struct ExecuteAgentSpend<'info> {
    #[account(mut)]
    pub agent_signer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"session", session.vault.as_ref(), &session.nonce.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,

    /// CHECK: Verified against `vault.allowlist` and `merchant_ata.owner` in policy evaluation.
    pub merchant: UncheckedAccount<'info>,

    #[account(mut)]
    pub merchant_ata: Account<'info, TokenAccount>,

    /// CHECK: Canonical Receipt PDA verified by seeds; allocated and serialized manually ONLY when all policy checks pass.
    #[account(
        mut,
        seeds = [b"receipt", vault.key().as_ref(), &request_hash],
        bump,
    )]
    pub receipt: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"session", vault.key().as_ref(), &session.nonce.to_le_bytes()],
        bump = session.bump,
        has_one = vault @ VaultError::VaultMismatch,
    )]
    pub session: Account<'info, Session>,
}

#[derive(Accounts)]
pub struct ReapIdleSession<'info> {
    pub caller: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [b"session", vault.key().as_ref(), &session.nonce.to_le_bytes()],
        bump = session.bump,
        has_one = vault @ VaultError::VaultMismatch,
    )]
    pub session: Account<'info, Session>,

    /// CHECK: Enforced via `address = vault.owner` so reclaimed rent can only go to the vault owner.
    #[account(
        mut,
        address = vault.owner @ VaultError::InvalidRentRecipient,
    )]
    pub rent_recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseExpiredReceipt<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [b"receipt", receipt.vault.as_ref(), &receipt.request_hash],
        bump = receipt.bump,
    )]
    pub receipt: Account<'info, Receipt>,

    /// CHECK: Enforced via `address = receipt.rent_payer` so reclaimed rent returns to the agent signer who paid for it.
    #[account(
        mut,
        address = receipt.rent_payer @ VaultError::InvalidRentRecipient,
    )]
    pub rent_recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerWithdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        address = vault.mint @ VaultError::InvalidMint,
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        address = vault.vault_ata @ VaultError::InvalidVaultAta,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

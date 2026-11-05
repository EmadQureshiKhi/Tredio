//! NEP-245 multi-token interface for every UP and DOWN token, on the `defuse-nep245` traits and
//! events from github.com/near/intents. Approvals are not supported (transfers are by owner).

use std::borrow::Cow;

use defuse_nep245::enumeration::MultiTokenEnumeration;
use defuse_nep245::resolver::{ClearedApproval, MultiTokenResolver};
use defuse_nep245::{MtBurnEvent, MtEvent, MtMintEvent, MtTransferEvent, MultiTokenCore, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, near, require, serde_json, AccountId, Gas, GasWeight, NearToken, Promise,
    PromiseOrValue,
};
use tredio_common::Side;

use crate::{parse_token_id, token_id, Outcomes, OutcomesExt};

const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(20);
const GAS_FOR_ON_TRANSFER_MIN: Gas = Gas::from_tgas(30);
const MAX_BATCH: usize = 32;

pub(crate) fn emit_mint(owner: &AccountId, ids: &[TokenId], amounts: &[u128], memo: Option<&str>) {
    MtEvent::MtMint(Cow::Owned(vec![MtMintEvent {
        owner_id: Cow::Borrowed(owner.as_ref()),
        token_ids: Cow::Borrowed(ids),
        amounts: Cow::Borrowed(amounts),
        memo: memo.map(Cow::Borrowed),
    }]))
    .emit();
}

pub(crate) fn emit_burn(owner: &AccountId, ids: &[TokenId], amounts: &[u128], memo: Option<&str>) {
    MtEvent::MtBurn(Cow::Owned(vec![MtBurnEvent {
        owner_id: Cow::Borrowed(owner.as_ref()),
        authorized_id: None,
        token_ids: Cow::Borrowed(ids),
        amounts: Cow::Borrowed(amounts),
        memo: memo.map(Cow::Borrowed),
    }]))
    .emit();
}

fn emit_transfer(from: &AccountId, to: &AccountId, ids: &[TokenId], amounts: &[u128], memo: Option<&str>) {
    MtEvent::MtTransfer(Cow::Owned(vec![MtTransferEvent {
        authorized_id: None,
        old_owner_id: Cow::Borrowed(from.as_ref()),
        new_owner_id: Cow::Borrowed(to.as_ref()),
        token_ids: Cow::Borrowed(ids),
        amounts: Cow::Borrowed(amounts),
        memo: memo.map(Cow::Borrowed),
    }]))
    .emit();
}

impl Outcomes {
    fn transfer_batch(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        token_ids: &[TokenId],
        amounts: &[U128],
        approvals: Option<&Vec<Option<(AccountId, u64)>>>,
        memo: Option<&str>,
    ) {
        require!(approvals.is_none_or(|a| a.iter().all(Option::is_none)), "approvals are not supported");
        require!(sender != receiver, "sender and receiver must differ");
        require!(
            !token_ids.is_empty() && token_ids.len() == amounts.len(),
            "token ids and amounts must match"
        );
        require!(token_ids.len() <= MAX_BATCH, "batch too large");
        for (id, amount) in token_ids.iter().zip(amounts) {
            require!(amount.0 > 0, "zero amount");
            let (series, side) = parse_token_id(id);
            self.debit(series, side, sender, amount.0);
            self.credit(series, side, receiver, amount.0);
        }
        let raw: Vec<u128> = amounts.iter().map(|a| a.0).collect();
        emit_transfer(sender, receiver, token_ids, &raw, memo);
    }

    fn transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer_batch(&sender, &receiver_id, &token_ids, &amounts, approvals.as_ref(), memo.as_deref());
        require!(
            env::prepaid_gas().saturating_sub(env::used_gas())
                > GAS_FOR_RESOLVE.saturating_add(GAS_FOR_ON_TRANSFER_MIN),
            "more gas is required"
        );
        let previous_owner_ids = vec![sender.clone(); token_ids.len()];
        let args = serde_json::json!({
            "sender_id": sender,
            "previous_owner_ids": previous_owner_ids,
            "token_ids": token_ids,
            "amounts": amounts,
            "msg": msg,
        });
        Promise::new(receiver_id.clone())
            .function_call_weight(
                "mt_on_transfer",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FOR_ON_TRANSFER_MIN,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .with_unused_gas_weight(0)
                    .mt_resolve_transfer(previous_owner_ids, receiver_id, token_ids, amounts, None),
            )
            .into()
    }
}

#[near]
impl MultiTokenCore for Outcomes {
    #[payable]
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer_batch(
            &sender,
            &receiver_id,
            &[token_id],
            &[amount],
            Some(&vec![approval]),
            memo.as_deref(),
        );
    }

    #[payable]
    fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer_batch(&sender, &receiver_id, &token_ids, &amounts, approvals.as_ref(), memo.as_deref());
    }

    #[payable]
    fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        self.transfer_call(receiver_id, vec![token_id], vec![amount], Some(vec![approval]), memo, msg)
    }

    #[payable]
    fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        self.transfer_call(receiver_id, token_ids, amounts, approvals, memo, msg)
    }

    fn mt_token(&self, token_ids: Vec<TokenId>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|id| {
                let (series, _) = parse_token_id(&id);
                self.series.contains_key(&series).then_some(Token { token_id: id, owner_id: None })
            })
            .collect()
    }

    fn mt_balance_of(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        let (series, side) = parse_token_id(&token_id);
        U128(self.balance(series, side, &account_id))
    }

    fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<TokenId>) -> Vec<U128> {
        token_ids.iter().map(|id| self.mt_balance_of(account_id.clone(), id.clone())).collect()
    }

    fn mt_supply(&self, token_id: TokenId) -> Option<U128> {
        let (series, side) = parse_token_id(&token_id);
        self.series.get(&series).map(|s| U128(s.supply(side)))
    }

    fn mt_batch_supply(&self, token_ids: Vec<TokenId>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|id| self.mt_supply(id)).collect()
    }
}

#[near]
impl MultiTokenResolver for Outcomes {
    /// Returns what the receiver kept of each token. Unused amounts the receiver reported (or
    /// everything, if its `mt_on_transfer` failed) go back to the sender, bounded by what the
    /// receiver still holds.
    #[private]
    fn mt_resolve_transfer(
        &mut self,
        previous_owner_ids: Vec<AccountId>,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Vec<ClearedApproval>>>>,
    ) -> Vec<U128> {
        let _ = approvals;
        let unused: Vec<U128> = env::promise_result_checked(0, 16_384)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<U128>>(&bytes).ok())
            .filter(|u| u.len() == amounts.len())
            .unwrap_or_else(|| amounts.clone());
        let mut used = Vec::with_capacity(amounts.len());
        for (i, id) in token_ids.iter().enumerate() {
            let (series, side) = parse_token_id(id);
            let want_back = unused[i].0.min(amounts[i].0);
            let refund = want_back.min(self.balance(series, side, &receiver_id));
            if refund > 0 {
                let sender = &previous_owner_ids[i];
                self.debit(series, side, &receiver_id, refund);
                if self.storage.is_registered(sender) {
                    self.credit(series, side, sender, refund);
                    emit_transfer(&receiver_id, sender, std::slice::from_ref(id), &[refund], Some("refund"));
                } else {
                    // The sender left storage meanwhile: the tokens are burned rather than lost
                    // to an unregistered account (and the burn is logged).
                    let mut s = self.get(series);
                    match side {
                        Side::Up => s.up_supply -= refund,
                        Side::Down => s.down_supply -= refund,
                    }
                    self.series.insert(series, s);
                    emit_burn(&receiver_id, std::slice::from_ref(id), &[refund], Some("refund"));
                }
            }
            used.push(U128(amounts[i].0 - refund));
        }
        used
    }
}

#[near]
impl MultiTokenEnumeration for Outcomes {
    /// Tokens of the series in id order (two per series), from `from_index`.
    fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        let start = from_index.map_or(0, |i| i.0 as u64);
        let limit = limit.unwrap_or(50).min(200) as u64;
        (start..(start + limit).min(2 * (self.next_series - 1)))
            .map(|i| {
                let series = i / 2 + 1;
                let side = if i % 2 == 0 { Side::Up } else { Side::Down };
                Token { token_id: token_id(series, side), owner_id: None }
            })
            .collect()
    }

    /// Not indexed on chain (balances are keyed by token and owner); the Tredio indexer serves
    /// holdings per owner from the NEP-245 events.
    fn mt_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<Token> {
        let _ = (account_id, from_index, limit);
        Vec::new()
    }
}

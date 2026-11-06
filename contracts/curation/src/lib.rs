//! # Tredio curation rewards
//!
//! Collects the curation share of perp and curve fees and credits it to the account that first
//! surfaced each trend. Fee sources (the perps and coins contracts) pay in USDC with
//! `ft_transfer_call`, naming the trend and its surfacer in the message; trends without a
//! surfacer credit the treasury. Surfacers claim whenever they like.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_AFTER_CLAIM: Gas = Gas::from_tgas(10);

/// What a fee source puts in `msg`.
#[near(serializers = [json])]
pub struct AccrueMsg {
    pub trend: String,
    pub surfacer: Option<AccountId>,
}

#[near(event_json(standard = "tredio-curation"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    Accrued { trend: &'a str, surfacer: &'a AccountId, source: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    Claimed { account: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    ClaimRefunded { account: &'a AccountId, amount: U128 },
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Sources,
    Claimable,
    EarnedByTrend,
    EarnedByAccount,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Curation {
    owner: AccountId,
    usdc: AccountId,
    treasury: AccountId,
    /// Contracts whose fee payments are accepted (perps, coins).
    sources: IterableSet<AccountId>,
    claimable: LookupMap<AccountId, u128>,
    earned_by_trend: LookupMap<String, u128>,
    earned_by_account: LookupMap<AccountId, u128>,
    total_accrued: u128,
    total_claimed: u128,
}

#[near]
impl Curation {
    #[init]
    pub fn new(owner: AccountId, usdc: AccountId, treasury: AccountId) -> Self {
        Self {
            owner,
            usdc,
            treasury,
            sources: IterableSet::new(Key::Sources),
            claimable: LookupMap::new(Key::Claimable),
            earned_by_trend: LookupMap::new(Key::EarnedByTrend),
            earned_by_account: LookupMap::new(Key::EarnedByAccount),
            total_accrued: 0,
            total_claimed: 0,
        }
    }

    #[payable]
    pub fn add_source(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        // A full-access key only: a function-call key cannot attach the yoctoNEAR.
        near_sdk::assert_one_yocto();
        self.sources.insert(account_id);
    }

    /// Sends everything the caller can claim to the caller. A failed transfer is credited back.
    pub fn claim(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.claimable.remove(&account).unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.total_claimed += amount;
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer",
                near_sdk::serde_json::json!({ "receiver_id": account, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AFTER_CLAIM)
                    .after_claim(account, U128(amount)),
            )
    }

    #[private]
    pub fn after_claim(&mut self, account: AccountId, amount: U128) -> U128 {
        match tredio_common::promise_succeeded() {
            true => {
                Event::Claimed { account: &account, amount }.emit();
                amount
            }
            false => {
                // The transfer failed (for example the account is not registered with USDC):
                // nothing left, so the claim is restored.
                *self.claimable.entry(account.clone()).or_insert(0) += amount.0;
                self.total_claimed -= amount.0;
                Event::ClaimRefunded { account: &account, amount }.emit();
                U128(0)
            }
        }
    }

    pub fn claimable_of(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    pub fn earned_by_trend(&self, trend: String) -> U128 {
        U128(self.earned_by_trend.get(&trend).copied().unwrap_or(0))
    }

    pub fn earned_by_account(&self, account_id: AccountId) -> U128 {
        U128(self.earned_by_account.get(&account_id).copied().unwrap_or(0))
    }

    pub fn totals(&self) -> (U128, U128) {
        (U128(self.total_accrued), U128(self.total_claimed))
    }
}

#[near]
impl FungibleTokenReceiver for Curation {
    /// Fee payments: USDC from an allowed source, `msg` = [`AccrueMsg`]. Anything else is
    /// refunded in full.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc || !self.sources.contains(&sender_id) {
            return PromiseOrValue::Value(amount);
        }
        let Ok(m) = near_sdk::serde_json::from_str::<AccrueMsg>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let surfacer = m.surfacer.unwrap_or_else(|| self.treasury.clone());
        *self.claimable.entry(surfacer.clone()).or_insert(0) += amount.0;
        *self.earned_by_trend.entry(m.trend.clone()).or_insert(0) += amount.0;
        *self.earned_by_account.entry(surfacer.clone()).or_insert(0) += amount.0;
        self.total_accrued += amount.0;
        Event::Accrued { trend: &m.trend, surfacer: &surfacer, source: &sender_id, amount }.emit();
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(who: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(who.parse().unwrap()).build());
    }

    fn setup() -> Curation {
        ctx("owner.testnet");
        let mut c = Curation::new(
            "owner.testnet".parse().unwrap(),
            "usdc.testnet".parse().unwrap(),
            "treasury.testnet".parse().unwrap(),
        );
        // Owner setters take one yoctoNEAR, which only a full-access key can attach.
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("owner.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.add_source("perps.testnet".parse().unwrap());
        c
    }

    fn pay(c: &mut Curation, sender: &str, amount: u128, msg: &str) -> u128 {
        ctx("usdc.testnet");
        match c.ft_on_transfer(sender.parse().unwrap(), U128(amount), msg.to_string()) {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("unexpected promise"),
        }
    }

    #[test]
    fn credits_the_surfacer_or_the_treasury() {
        let mut c = setup();
        assert_eq!(pay(&mut c, "perps.testnet", 100, r#"{"trend":"topic:a","surfacer":"alice.testnet"}"#), 0);
        assert_eq!(pay(&mut c, "perps.testnet", 50, r#"{"trend":"topic:b","surfacer":null}"#), 0);
        assert_eq!(c.claimable_of("alice.testnet".parse().unwrap()).0, 100);
        assert_eq!(c.claimable_of("treasury.testnet".parse().unwrap()).0, 50);
        assert_eq!(c.earned_by_trend("topic:a".into()).0, 100);
        assert_eq!(c.totals().0 .0, 150);
    }

    #[test]
    fn refunds_unknown_sources_tokens_and_messages() {
        let mut c = setup();
        assert_eq!(pay(&mut c, "mallory.testnet", 100, r#"{"trend":"topic:a","surfacer":"m.testnet"}"#), 100);
        assert_eq!(pay(&mut c, "perps.testnet", 100, "not json"), 100);
        ctx("fake-usdc.testnet");
        let r = c.ft_on_transfer(
            "perps.testnet".parse().unwrap(),
            U128(5),
            r#"{"trend":"t","surfacer":null}"#.into(),
        );
        assert!(matches!(r, PromiseOrValue::Value(U128(5))));
        assert_eq!(c.totals().0 .0, 0);
    }

    #[test]
    fn a_claim_whose_transfer_failed_is_restored() {
        let mut c = setup();
        pay(&mut c, "perps.testnet", 100, r#"{"trend":"topic:a","surfacer":"alice.testnet"}"#);
        ctx("alice.testnet");
        let _ = c.claim();
        assert_eq!(c.claimable_of("alice.testnet".parse().unwrap()).0, 0);
        assert_eq!(c.totals().1 .0, 100, "counted as claimed while the transfer is in flight");
        // No promise result: the transfer failed (for example, alice holds no USDC storage).
        ctx("curation.testnet");
        assert_eq!(c.after_claim("alice.testnet".parse().unwrap(), U128(100)).0, 0);
        assert_eq!(c.claimable_of("alice.testnet".parse().unwrap()).0, 100);
        assert_eq!(c.totals().1 .0, 0);
    }

    #[test]
    #[should_panic(expected = "nothing to claim")]
    fn claim_needs_a_balance() {
        let mut c = setup();
        ctx("bob.testnet");
        let _ = c.claim();
    }
}

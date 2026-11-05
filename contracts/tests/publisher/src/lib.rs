//! Sandbox test helper: near-workspaces has no global-contract action, so tests publish code
//! through this contract instead.

use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near, Promise};

#[near(contract_state)]
#[derive(Default)]
pub struct Publisher;

#[near]
impl Publisher {
    /// Publishes `code` as a global contract referenced by its hash.
    pub fn publish(&mut self, code: Base64VecU8) -> Promise {
        Promise::new(env::current_account_id()).deploy_global_contract(code.0)
    }
}

import { accountsFactory, canonicalOwnerKey, parseNearAmount, userAccount as ev } from "../events";
import type { Tx } from "../db";
import { type Handler, on, secs } from "./context";

async function seen(tx: Tx, account: string, at: Date) {
  await tx`insert into accounts (account, first_seen) values (${account}, ${at}) on conflict (account) do nothing`;
}

/** The accounts factory (`tredio-accounts`). */
export const factoryHandlers: Record<string, Handler> = {
  account_created: on(accountsFactory.account_created, async ({ tx, e }, d) => {
    await tx`
      insert into accounts (account, owner_key, funded, created_at, first_seen)
      values (${d.account}, ${canonicalOwnerKey(d.owner_key)}, ${parseNearAmount(d.funded)}, ${e.block_time}, ${e.block_time})
      on conflict (account) do update
        set owner_key = excluded.owner_key, funded = coalesce(accounts.funded, 0) + coalesce(excluded.funded, 0),
            created_at = coalesce(accounts.created_at, excluded.created_at)`;
  }),
};

/** A user account's own events (`tredio-account`); the executor is the account. */
export const accountHandlers: Record<string, Handler> = {
  session_added: on(ev.session_added, async ({ tx, e }, d) => {
    await seen(tx, e.executor, e.block_time);
    await tx`
      insert into sessions (account, public_key, label, scope, expires_at, daily_limit, gas_key, added_at, revoked_at)
      values (${e.executor}, ${d.public_key}, ${d.label}, ${tx.json(d.scope)}, ${secs(d.expires_at)}, ${d.daily_limit},
              ${d.gas_key}, ${e.block_time}, null)
      on conflict (account, public_key) do update
        set label = excluded.label, scope = excluded.scope, expires_at = excluded.expires_at, daily_limit = excluded.daily_limit,
            gas_key = excluded.gas_key, added_at = excluded.added_at, revoked_at = null`;
  }),

  session_revoked: on(ev.session_revoked, async ({ tx, e }, d) => {
    await tx`
      update sessions set revoked_at = ${e.block_time}
      where account = ${e.executor} and public_key = ${d.public_key} and revoked_at is null`;
  }),

  frozen: on(ev.frozen, async ({ tx, e }, d) => {
    await seen(tx, e.executor, e.block_time);
    await tx`update accounts set frozen = ${d.frozen} where account = ${e.executor}`;
  }),

  upgraded: on(ev.upgraded, async ({ tx, e }, d) => {
    await seen(tx, e.executor, e.block_time);
    await tx`update accounts set code_hash = ${d.code_hash} where account = ${e.executor}`;
  }),

  session_action: on(ev.session_action, async ({ tx, e }, d) => {
    await tx`
      insert into session_actions (receipt_id, log_index, account, public_key, action, outflow, spent_today, at, block_height)
      values (${e.receipt_id}, ${e.log_index}, ${e.executor}, ${d.public_key}, ${d.action}, ${d.outflow}, ${d.spent_today},
              ${e.block_time}, ${e.block_height})
      on conflict do nothing`;
  }),

  hyperliquid_signed: on(ev.hyperliquid_signed, async ({ tx, e }, d) => {
    await tx`
      insert into hyperliquid_signatures (receipt_id, log_index, account, digest, kind, at, block_height)
      values (${e.receipt_id}, ${e.log_index}, ${e.executor}, ${d.digest}, ${d.kind}, ${e.block_time}, ${e.block_height})
      on conflict do nothing`;
  }),
};

//! The matching engine: price levels as FIFO linked lists of orders, active ticks as bitmaps.

use near_sdk::json_types::U128;
use near_sdk::{env, require, AccountId};
use tredio_common::{now_secs, Side};

use crate::{
    Asset, Book, Dir, Event, Level, Market, Order, OrderSpec, Placement, TimeInForce, LOT, MAX_FILLS,
    MAX_TICK, MIN_TICK,
};

pub(crate) fn bit(bits: &[u64; 16], tick: u16) -> bool {
    bits[(tick / 64) as usize] >> (tick % 64) & 1 == 1
}

fn set_bit(bits: &mut [u64; 16], tick: u16, on: bool) {
    let (w, b) = ((tick / 64) as usize, tick % 64);
    if on {
        bits[w] |= 1 << b;
    } else {
        bits[w] &= !(1 << b);
    }
}

/// Lowest set tick at or above `from`.
fn next_up(bits: &[u64; 16], from: u16) -> Option<u16> {
    (from..=MAX_TICK).find(|t| bit(bits, *t))
}

/// Highest set tick at or below `from`.
fn next_down(bits: &[u64; 16], from: u16) -> Option<u16> {
    (MIN_TICK..=from).rev().find(|t| bit(bits, *t))
}

/// USDC (6 decimals) for `size` raw tokens at `tick`: size / 1e6 tokens times tick / 1000 USDC.
pub(crate) fn cost(size: u128, tick: u16) -> u128 {
    size / LOT * tick as u128
}

/// What a sweep did for the taker.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Fill {
    pub size: u128,
    pub usdc: u128,
    pub fee: u128,
}

impl Book {
    fn market(&self, series: u64, side: Side) -> Market {
        self.markets.get(&(series, side)).cloned().unwrap_or_else(|| env::panic_str("unknown market"))
    }

    /// Takes liquidity from the side opposite to `dir`, best price first, up to `limit_tick`,
    /// at most `max_size` tokens and (for buys) at most `budget` USDC including fees. Makers are
    /// settled into their balances; the taker's side is returned for the caller to settle.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn take(
        &mut self,
        taker: &AccountId,
        series: u64,
        side: Side,
        dir: Dir,
        limit_tick: u16,
        max_size: u128,
        budget: Option<u128>,
    ) -> Fill {
        let mut m = self.market(series, side);
        require!(now_secs() < m.expiry, "market expired");
        let maker_is_bid = dir == Dir::Sell;
        let mut fill = Fill::default();
        let mut fills = 0u32;
        loop {
            if fill.size >= max_size || fills >= MAX_FILLS {
                break;
            }
            let bits = if maker_is_bid { &m.bids } else { &m.asks };
            let best = if maker_is_bid { next_down(bits, MAX_TICK) } else { next_up(bits, MIN_TICK) };
            let Some(tick) = best else { break };
            if (maker_is_bid && tick < limit_tick) || (!maker_is_bid && tick > limit_tick) {
                break;
            }
            let key = (series, side, maker_is_bid, tick);
            let level = self.levels.get(&key).cloned().unwrap_or_default();
            let Some(maker) = self.orders.get(&level.head).cloned() else {
                // A level without orders should not exist; clear it so matching can go on.
                set_bit(if maker_is_bid { &mut m.bids } else { &mut m.asks }, tick, false);
                self.levels.remove(&key);
                continue;
            };
            if &maker.owner == taker {
                // Self-trade prevention: the resting order is cancelled.
                self.markets.insert((series, side), m.clone());
                self.cancel(maker.id);
                m = self.market(series, side);
                continue;
            }
            let mut size = maker.remaining.0.min(max_size - fill.size);
            if let Some(budget) = budget {
                let left = budget - fill.usdc - fill.fee;
                // Lots affordable at this tick with the fee on top.
                let per_lot = tick as u128;
                let mut lots = left * 10_000 / (per_lot * (10_000 + self.taker_fee_bps as u128));
                while lots > 0 && cost(lots * LOT, tick) + self.fee_on(cost(lots * LOT, tick)) > left {
                    lots -= 1;
                }
                size = size.min(lots * LOT);
            }
            size -= size % LOT;
            if size == 0 {
                break;
            }
            let usdc = cost(size, tick);
            let fee = self.fee_on(usdc);
            fill.size += size;
            fill.usdc += usdc;
            fill.fee += fee;
            fills += 1;
            // Settle the maker: a bid's locked USDC buys the tokens; an ask's locked tokens sell.
            if maker_is_bid {
                self.credit(&maker.owner, Asset::Token { series, side }, size);
            } else {
                self.credit(&maker.owner, Asset::Usdc, usdc);
            }
            Event::Trade {
                series,
                side,
                maker_order: maker.id,
                maker: &maker.owner,
                taker,
                taker_dir: dir,
                tick,
                size: U128(size),
                usdc: U128(usdc),
                fee: U128(fee),
            }
            .emit();
            m.last_tick = Some(tick);
            m.volume_usdc = U128(m.volume_usdc.0 + usdc);
            m.trades += 1;
            self.markets.insert((series, side), m.clone());
            self.reduce(maker.id, size);
            m = self.market(series, side);
        }
        self.fees += fill.fee;
        fill
    }

    /// Takes `size` off a resting order, removing it when it is used up.
    fn reduce(&mut self, id: u64, size: u128) {
        let mut o = self.orders.get(&id).cloned().unwrap();
        let key = (o.series, o.side, o.dir == Dir::Buy, o.tick);
        let mut level = self.levels.get(&key).cloned().unwrap();
        level.size -= size;
        o.remaining = U128(o.remaining.0 - size);
        if o.remaining.0 == 0 {
            self.unlink(&o, level);
            self.orders.remove(&id);
            self.storage.remove_entry(&o.owner);
        } else {
            self.levels.insert(key, level);
            self.orders.insert(id, o);
        }
    }

    /// Removes `o` from its level's list (the level's size is already adjusted).
    fn unlink(&mut self, o: &Order, mut level: Level) {
        let key = (o.series, o.side, o.dir == Dir::Buy, o.tick);
        if o.prev != 0 {
            let mut p = self.orders.get(&o.prev).cloned().unwrap();
            p.next = o.next;
            self.orders.insert(p.id, p);
        } else {
            level.head = o.next;
        }
        if o.next != 0 {
            let mut n = self.orders.get(&o.next).cloned().unwrap();
            n.prev = o.prev;
            self.orders.insert(n.id, n);
        } else {
            level.tail = o.prev;
        }
        if level.head == 0 {
            self.levels.remove(&key);
            let mut m = self.market(o.series, o.side);
            set_bit(if o.dir == Dir::Buy { &mut m.bids } else { &mut m.asks }, o.tick, false);
            self.markets.insert((o.series, o.side), m);
        } else {
            self.levels.insert(key, level);
        }
    }

    /// Cancels a resting order and returns its locked funds to the owner's balance.
    pub(crate) fn cancel(&mut self, id: u64) -> u128 {
        let o = self.orders.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown order"));
        let key = (o.series, o.side, o.dir == Dir::Buy, o.tick);
        let mut level = self.levels.get(&key).cloned().unwrap();
        level.size -= o.remaining.0;
        self.unlink(&o, level);
        self.orders.remove(&id);
        self.storage.remove_entry(&o.owner);
        match o.dir {
            Dir::Buy => self.credit(&o.owner, Asset::Usdc, cost(o.remaining.0, o.tick)),
            Dir::Sell => {
                self.credit(&o.owner, Asset::Token { series: o.series, side: o.side }, o.remaining.0)
            }
        }
        Event::OrderCancelled { id, owner: &o.owner, remaining: o.remaining }.emit();
        o.remaining.0
    }

    /// Rests `size` at `tick`, funds already locked by the caller.
    fn rest(&mut self, owner: &AccountId, spec: &OrderSpec, size: u128) -> u64 {
        self.storage.add_entry(owner);
        let id = self.next_order;
        self.next_order += 1;
        let is_bid = spec.dir == Dir::Buy;
        let key = (spec.series, spec.side, is_bid, spec.tick);
        let mut level = self.levels.get(&key).cloned().unwrap_or_default();
        let order = Order {
            id,
            owner: owner.clone(),
            series: spec.series,
            side: spec.side,
            dir: spec.dir,
            tick: spec.tick,
            remaining: U128(size),
            placed_at: now_secs(),
            prev: level.tail,
            next: 0,
        };
        if level.tail != 0 {
            let mut t = self.orders.get(&level.tail).cloned().unwrap();
            t.next = id;
            self.orders.insert(t.id, t);
        } else {
            level.head = id;
        }
        level.tail = id;
        level.size += size;
        self.levels.insert(key, level);
        self.orders.insert(id, order);
        let mut m = self.market(spec.series, spec.side);
        set_bit(if is_bid { &mut m.bids } else { &mut m.asks }, spec.tick, true);
        self.markets.insert((spec.series, spec.side), m);
        Event::OrderPlaced {
            id,
            owner,
            series: spec.series,
            side: spec.side,
            dir: spec.dir,
            tick: spec.tick,
            size: U128(size),
        }
        .emit();
        id
    }

    /// Places an order for a trading account, against its deposited balance.
    pub(crate) fn place(&mut self, owner: &AccountId, spec: &OrderSpec) -> Placement {
        require!((MIN_TICK..=MAX_TICK).contains(&spec.tick), "tick out of range");
        let size = spec.size.0;
        require!(size > 0 && size.is_multiple_of(LOT), "size must be a positive multiple of 0.001 token");
        let m = self.market(spec.series, spec.side);
        require!(now_secs() < m.expiry, "market expired");
        let token = Asset::Token { series: spec.series, side: spec.side };
        let crosses = match spec.dir {
            Dir::Buy => next_up(&m.asks, MIN_TICK).is_some_and(|a| a <= spec.tick),
            Dir::Sell => next_down(&m.bids, MAX_TICK).is_some_and(|b| b >= spec.tick),
        };
        if spec.tif == TimeInForce::PostOnly && crosses {
            Event::OrderSkipped {
                owner,
                series: spec.series,
                side: spec.side,
                dir: spec.dir,
                tick: spec.tick,
                reason: "would cross",
            }
            .emit();
            return Placement { skipped: true, ..Default::default() };
        }
        let fill = if crosses {
            // The taker must be able to cover the worst case before matching starts.
            match spec.dir {
                Dir::Buy => {
                    let worst = cost(size, spec.tick);
                    require!(
                        self.balance(owner, Asset::Usdc) >= worst + self.fee_on(worst),
                        "insufficient balance"
                    );
                }
                Dir::Sell => require!(self.balance(owner, token) >= size, "insufficient balance"),
            }
            self.take(owner, spec.series, spec.side, spec.dir, spec.tick, size, None)
        } else {
            Default::default()
        };
        let paid = match spec.dir {
            Dir::Buy => {
                self.debit(owner, Asset::Usdc, fill.usdc + fill.fee);
                self.credit(owner, token, fill.size);
                fill.usdc + fill.fee
            }
            Dir::Sell => {
                self.debit(owner, token, fill.size);
                self.credit(owner, Asset::Usdc, fill.usdc - fill.fee);
                fill.usdc - fill.fee
            }
        };
        let left = size - fill.size;
        let order_id = if left > 0 && spec.tif != TimeInForce::Ioc {
            match spec.dir {
                Dir::Buy => self.debit(owner, Asset::Usdc, cost(left, spec.tick)),
                Dir::Sell => self.debit(owner, token, left),
            }
            Some(self.rest(owner, spec, left))
        } else {
            None
        };
        Placement { order_id, filled: U128(fill.size), usdc: U128(paid), skipped: false }
    }

    /// Cancels up to `max` resting orders of an expired market, returning their locks.
    pub(crate) fn sweep_expired(&mut self, series: u64, side: Side, max: u32) -> u32 {
        let m = self.market(series, side);
        require!(now_secs() >= m.expiry, "market not expired");
        let mut done = 0;
        while done < max {
            let m = self.market(series, side);
            let next = next_up(&m.asks, MIN_TICK)
                .map(|t| (false, t))
                .or_else(|| next_down(&m.bids, MAX_TICK).map(|t| (true, t)));
            let Some((is_bid, tick)) = next else { break };
            let head = self.levels.get(&(series, side, is_bid, tick)).map_or(0, |l| l.head);
            if head == 0 {
                break;
            }
            self.cancel(head);
            done += 1;
        }
        done
    }
}

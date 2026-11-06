import { DRY_RUN_ACCOUNT, depositRequest, explorerUrl, hyperliquidFundingRequest, hyperliquidReturnRequest, isFinal, type OneClick, OneClickError, type QuoteResponse, type StatusResponse, withdrawalRequest } from "@tredio/intents";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Sql } from "../db";
import type { Log } from "../log";
import { rateLimit } from "../api/rate-limit";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

/**
 * Any-chain deposits and withdrawals through NEAR Intents 1Click (packages/intents), and USDC to and
 * from the account's Hyperliquid perps balance. On mainnet a quote opens a deposit address that
 * 1Click watches; the API keeps one row per address with the swap's latest state, refreshed while
 * someone looks. On testnet 1Click does not exist, so quotes are dry (no deposit address) at
 * mainnet prices, to show the route and its cost.
 */

type Vars = { Variables: { user: string; token: string } };

export interface DepositDeps {
  sql: Sql;
  oneClick: OneClick;
  network: "testnet" | "mainnet";
  signedIn: MiddlewareHandler<Vars>;
  log: Log;
  now?: () => number;
}

interface DepositRow {
  id: string;
  account: string;
  deposit_address: string;
  deposit_memo: string | null;
  state: { quote: QuoteResponse; status?: StatusResponse; direction: Direction };
  phase: string;
  created_at: Date;
  updated_at: Date;
}

/** `hyperliquid` funds the account's Hyperliquid perps balance from NEAR; `from-hyperliquid` brings USDC back to NEAR. */
const DIRECTIONS = ["deposit", "withdraw", "hyperliquid", "from-hyperliquid"] as const;
type Direction = (typeof DIRECTIONS)[number];

const quoteBody = z.discriminatedUnion("direction", [
  z.object({ direction: z.literal("deposit"), asset: z.string().min(3).max(200), amount: z.string().regex(/^\d{1,40}$/), refundTo: z.string().min(2).max(200) }),
  z.object({ direction: z.literal("withdraw"), asset: z.string().min(3).max(200), amount: z.string().regex(/^\d{1,40}$/), recipient: z.string().min(2).max(200) }),
  z.object({ direction: z.literal("hyperliquid"), amount: z.string().regex(/^\d{1,40}$/), hyperliquidAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
  z.object({ direction: z.literal("from-hyperliquid"), amount: z.string().regex(/^\d{1,30}$/), hyperliquidAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
]);

/** A row's status is read from 1Click again at most this often. */
const REFRESH_MS = 10_000;

function rowJson(r: DepositRow) {
  const q = r.state.quote.quote;
  return {
    id: Number(r.id),
    direction: r.state.direction,
    depositAddress: r.deposit_address,
    depositMemo: r.deposit_memo,
    amountIn: q.amountInFormatted,
    amountOut: q.amountOutFormatted,
    amountInUsd: q.amountInUsd,
    originAsset: r.state.quote.quoteRequest.originAsset,
    destinationAsset: r.state.quote.quoteRequest.destinationAsset,
    deadline: q.deadline ?? null,
    phase: r.phase,
    details: r.state.status?.swapDetails ?? null,
    explorer: explorerUrl(r.deposit_address),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export function depositRoutes(d: DepositDeps) {
  const app = new Hono<Vars>();
  const now = d.now ?? Date.now;
  const live = d.network === "mainnet";
  const perAccount = rateLimit<Vars>(30, 600_000, (c) => `deposits:${c.get("user")}`, now);

  const refuse = (e: unknown) => {
    if (e instanceof OneClickError) return { body: { error: e.message.replace(/^1Click [^:]*: /, "") }, status: (e.status >= 500 ? 502 : 400) as 400 | 502 };
    throw e;
  };

  // The assets 1Click can route, for the deposit and withdrawal pickers.
  app.get("/deposits/assets", async (c) => {
    try {
      const tokens = await d.oneClick.tokens();
      return c.json({
        network: d.network,
        live,
        confidential: d.oneClick.authenticated,
        assets: tokens.map((t) => ({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, priceUsd: t.price })),
      });
    } catch (e) {
      d.log.warn({ err: e instanceof Error ? e.message : String(e) }, "1Click tokens failed");
      return c.json({ error: "deposit routes are unavailable right now" }, 502);
    }
  });

  // A quote. Mainnet: a live quote with a deposit address, kept per account. Testnet: a dry quote.
  app.post("/deposits/quote", d.signedIn, perAccount, async (c) => {
    const b = quoteBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad request" }, 400);
    const account = live ? c.get("user") : DRY_RUN_ACCOUNT;
    const q = b.data;
    const req =
      q.direction === "deposit"
        ? depositRequest({ originAsset: q.asset, amount: q.amount, account, refundTo: q.refundTo, dry: !live, now: now() })
        : q.direction === "withdraw"
          ? withdrawalRequest({ destinationAsset: q.asset, amount: q.amount, account, recipient: q.recipient, dry: !live, now: now() })
          : q.direction === "hyperliquid"
            ? hyperliquidFundingRequest({ amount: q.amount, account, hyperliquidAddress: q.hyperliquidAddress, dry: !live, now: now() })
            : hyperliquidReturnRequest({ amount: q.amount, account, hyperliquidAddress: q.hyperliquidAddress, dry: !live, now: now() });
    let quote: QuoteResponse;
    try {
      quote = await d.oneClick.quote(req);
    } catch (e) {
      const r = refuse(e);
      return c.json(r.body, r.status);
    }
    const confidential = d.oneClick.confidential(quote.quoteRequest);
    if (!live || !quote.quote.depositAddress) return c.json({ dry: true, direction: q.direction, confidential, quote: quote.quote, signature: quote.signature });
    const [row] = await d.sql<DepositRow[]>`
      INSERT INTO deposits (account, deposit_address, deposit_memo, state, phase)
      VALUES (${c.get("user")}, ${quote.quote.depositAddress}, ${quote.quote.depositMemo ?? null}, ${d.sql.json({ quote, direction: q.direction } as never)}, 'PENDING_DEPOSIT')
      ON CONFLICT (deposit_address, deposit_memo) DO NOTHING RETURNING *`;
    if (!row) return c.json({ error: "1Click returned a deposit address already in use; ask again" }, 502);
    return c.json({ dry: false, direction: q.direction, confidential, quote: quote.quote, signature: quote.signature, deposit: rowJson(row) });
  });

  // The account's deposits and withdrawals, refreshing the ones still in flight.
  app.get("/deposits", d.signedIn, async (c) => {
    const rows = await d.sql<DepositRow[]>`SELECT * FROM deposits WHERE account = ${c.get("user")} ORDER BY created_at DESC LIMIT 50`;
    await Promise.all(
      rows
        .filter((r) => !isFinal(r.phase as StatusResponse["status"]) && now() - r.updated_at.getTime() > REFRESH_MS)
        .slice(0, 5)
        .map(async (r) => {
          try {
            const s = await d.oneClick.status(r.deposit_address, r.deposit_memo ?? undefined);
            const [u] = await d.sql<DepositRow[]>`
              UPDATE deposits SET state = ${d.sql.json({ ...r.state, status: s } as never)}, phase = ${s.status}, updated_at = now()
              WHERE id = ${r.id} RETURNING *`;
            if (u) Object.assign(r, u);
          } catch (e) {
            if (!(e instanceof OneClickError && e.status === 404)) d.log.warn({ err: e instanceof Error ? e.message : String(e) }, "1Click status failed");
          }
        }),
    );
    return c.json({ live, deposits: rows.map(rowJson) });
  });

  // Speeds a deposit up: tells 1Click the transaction that paid the deposit address.
  app.post("/deposits/:id/submit", d.signedIn, perAccount, async (c) => {
    const b = z.object({ txHash: z.string().min(8).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "txHash required" }, 400);
    const [row] = await d.sql<DepositRow[]>`SELECT * FROM deposits WHERE id = ${Number(c.req.param("id")) || 0} AND account = ${c.get("user")}`;
    if (!row) return c.json({ error: "no such deposit" }, 404);
    try {
      const s = await d.oneClick.submitDeposit(b.data.txHash, row.deposit_address, row.deposit_memo ?? undefined);
      await d.sql`UPDATE deposits SET state = ${d.sql.json({ ...row.state, status: s } as never)}, phase = ${s.status}, updated_at = now() WHERE id = ${row.id}`;
      return c.json({ phase: s.status });
    } catch (e) {
      const r = refuse(e);
      return c.json(r.body, r.status);
    }
  });

  return app;
}

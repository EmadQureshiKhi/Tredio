import { type Sender, type Viewer, walletHealth } from "@tredio/chain";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { RelayError, type Relayer } from "./relayer";

/**
 * The relayer's HTTP API. Every route answers `{ error }` with a short reason when it refuses, so
 * the app can show it as is.
 *
 * - POST /v1/accounts: create a passkey account (activation ticket, first owner request and proof).
 * - POST /v1/owner-execute: relay a passkey-signed owner request.
 * - POST /v1/sessions/fund: top up a session's gas key.
 * - POST /v1/meta: relay a NEAR wallet's signed delegate action (NEP-366).
 * - GET /health (detail for the status views), GET /live.
 */

const proof = z.object({ authenticator_data: z.string().min(40).max(2048), client_data_json: z.string().min(1).max(4096), signature: z.string().regex(/^[0-9a-f]{128}$/) });
const account = z.string().regex(/^[a-z0-9._-]{2,64}$/);
const createBody = z.object({
  ownerKey: z.string().regex(/^p256:[1-9A-HJ-NP-Za-km-z]{40,50}$/),
  request: z.string().min(10).max(8192),
  proof,
  ticket: z.object({ ownerKey: z.string(), account, expiresAt: z.number().int(), signature: z.string().max(100) }).nullable().default(null),
});
const executeBody = z.object({ account, request: z.string().min(10).max(8192), proof });
const fundBody = z.object({ account, publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/) });
const metaBody = z.object({ signedDelegate: z.string().min(40).max(16_384) });

export interface ServerDeps {
  relayer: Relayer;
  sender: Sender;
  viewer: Viewer;
  network: string;
  origins: string[];
  minBalance: bigint;
  startedAt: number;
}

export function createServer(d: ServerDeps): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: (o) => (d.origins.includes(o) ? o : null), allowHeaders: ["content-type"], exposeHeaders: ["retry-after"], maxAge: 600 }));
  app.onError((e, c) => c.json({ error: e instanceof Error ? e.message.slice(0, 200) : "internal error" }, 500));

  const handle = async (c: Context, schema: z.ZodType, run: (body: never) => Promise<unknown>) => {
    const b = schema.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad request" }, 400);
    try {
      return c.json((await run(b.data as never)) as object);
    } catch (e) {
      if (e instanceof RelayError) return c.json({ error: e.message }, e.status, e.status === 429 ? { "Retry-After": "300" } : {});
      throw e;
    }
  };

  app.post("/v1/accounts", (c) => handle(c, createBody, (b: z.infer<typeof createBody>) => d.relayer.createAccount(b)));
  app.post("/v1/owner-execute", (c) => handle(c, executeBody, (b: z.infer<typeof executeBody>) => d.relayer.ownerExecute(b)));
  app.post("/v1/sessions/fund", (c) => handle(c, fundBody, (b: z.infer<typeof fundBody>) => d.relayer.fundSession(b)));
  app.post("/v1/meta", (c) => handle(c, metaBody, (b: z.infer<typeof metaBody>) => d.relayer.relayMeta(b.signedDelegate)));

  app.get("/live", (c) => c.json({ live: true }));
  app.get("/health", async (c) => {
    const wallet = await walletHealth(d.viewer, "Relayer", d.sender.accountId, { min: d.minBalance, gasKeys: [d.sender.publicKey] });
    const balanceOk = wallet.balance !== null && Number(wallet.balance) >= Number(wallet.min);
    const s = d.relayer.stats;
    const ok = balanceOk;
    return c.json(
      {
        ok,
        service: "relayer",
        network: d.network,
        wallets: [wallet],
        alerts: balanceOk ? {} : { balance: `below ${wallet.min} NEAR` },
        lastError: s.lastError,
        facts: [
          { label: "Accounts created", value: String(s.accounts) },
          { label: "Owner requests", value: String(s.ownerCalls) },
          { label: "Gas key top-ups", value: String(s.topups) },
          { label: "Meta-transactions", value: String(s.meta) },
          { label: "Refused by budget", value: String(s.refused), tone: s.refused > 0 ? "warn" : undefined },
          { label: "Failed", value: String(s.failed), tone: s.failed > 0 ? "warn" : undefined },
          { label: "Running since", at: Math.floor(d.startedAt / 1000) },
        ],
        flags: [],
      },
      ok ? 200 : 503,
    );
  });
  return app;
}

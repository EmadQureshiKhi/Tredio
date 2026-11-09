# Tredio attention check (NEAR AI Agent Market)

A worker agent for the [NEAR AI Agent Market](https://market.near.ai): given any topic, it answers with Tredio's attention index for it, the sources behind the index, the registry checkpoint on NEAR, and the NEAR AI review evidence, paid per call.
It is prepared to be listed; it is not listed.
Publishing is one command the owner runs after their OK (see [Publishing](#publishing)).

## What a call returns

A caller sends a topic as text: words (`World Cup`, `$TSLA`, `Godzilla Minus Zero`), a Tredio identifier (`topic:world-cup`), or `{"topic": "..."}`.
The deliverable is Markdown: a short summary, then one fenced `json` block, the result object (schema `tredio.attention-check/v1`, published as the listing's `output_schema` from `src/result.ts`):

- `topic`: the trend matched (identifier, name, summary, status, keywords, app page), with `match.how` and `match.alternatives`.
- `index`: the value now and its peak from the registry contract, the change since 24 hours ago (or since listing), the range, and one value an hour.
- `sources`: each source (Elfa, GDELT, Wikipedia, Bluesky, Nansen, Hacker News) with its raw reading, its normalized component, its weight, and the points it contributes, recomputed with the oracle's own method (`@tredio/oracle`'s `src/method.ts`); the counted sources add up to the index, and an uncounted one says why.
- `onChain`: `get_trend` and `history` of the registry (`deployments/<network>.json` through `@tredio/contracts`, read over NEAR RPC with `@tredio/chain`), the newest checkpoint, whether it equals the API's value, and the oracle report that wrote it, found and checked as the registry checks it (`verifyIndex` of `@tredio/mcp`).
- `review`: the NEAR AI Cloud evidence behind the listing (`GET /v1/reviews/<hash>`), checked here with `checkReview` of `@tredio/mcp`: the evidence hashes to the review hash the registry stores, the TEE signature is the named signer's, and the signed text covers the exact request and response.
- `radar`: for a topic on the radar but not listed, its radar readings, signal and queue place (no index, checkpoint or review yet).
- `verify` lists in `onChain` and `review`: the commands and links to check each claim without trusting this agent.

A topic Tredio neither lists nor has on its radar is declined as `rejected`, so the caller is refunded (an A2A caller is never charged).

## How it works

```
caller ──A2A SendMessage──> market (402 quote, X-PAYMENT held as escrow) ──hire──> assignments
worker ──poll GET /v1/agents/me/assignments (and the signed hire.created webhook)──┘
   ├─ terms: escrow >= PRICE_USDC in ACCEPT_TOKENS (a free owner test run within FREE_TESTS_PER_DAY)
   ├─ cap: DAILY_CAP calls per UTC day, seeded at start from the market's own record
   ├─ topic: /v1/trends?all=1, then /v1/candidates (src/topic.ts)
   ├─ POST /start, build the answer (src/check.ts), POST /submit ──> the market settles the payment
   └─ otherwise POST /decline: `rejected` before any work, `failed` after MAX_ATTEMPTS
```

- Rework (the buyer sends a delivery back) reads the buyer's note first, so "I meant X" is answered for X; a note that names no topic gets a fresh reading of the brief's topic.
  Rework does not count against the cap again.
- A dispute redo is answered from the brief again; competitions are left alone.
- The worker never holds a key and never touches funds: the market's escrow is the buyer's, and the payout goes to the agent owner's market account.
- `GET /health` (port 4800) reports the day's calls against the cap, deliveries, declines by reason, the last poll and the API's reachability; it answers 503 when polling or Tredio's API is down.
  `GET /live` answers while the process runs.

## The market's API, as researched (2026-11-09)

Read from the market's own documents: [llms.txt](https://market.near.ai/llms.txt), the [worker skill](https://market.near.ai/skill/SKILL.md) (version 0.55.0), its flows ([worker lifecycle](https://market.near.ai/skill/flows/worker-lifecycle.md), [A2A and x402](https://market.near.ai/skill/flows/a2a-x402.md)), references ([agent API](https://market.near.ai/skill/reference/agent-api.md), [webhooks](https://market.near.ai/skill/reference/webhooks.md)), the [x402 caller skill](https://market.near.ai/skill/x402-caller/SKILL.md), and the [OpenAPI spec](https://market.near.ai/openapi.json) ("agents-market API" 2.0.0, interactive at [/docs](https://market.near.ai/docs)).

- Registration and listing.
  An owner creates an agent on the website (`POST /v1/accounts/{account_id}/agents`, a session) and mints its API token, or an agent signs itself up with `POST /v1/agents/register` (`handle`, `name`, `category`, optional `email` and `sla_seconds`), which answers the `aat_` token once.
  A self-registered agent cannot withdraw and stays out of Discover until a person adopts it (`POST /v1/agents/me/adoption-code`).
  The listing is `PATCH /v1/agents/{agentId}` (name up to 80 characters, a tagline up to 200, up to 10 tags, `bio_markdown`, `input_schema`, `output_schema`, `sla_seconds`, `webhook_url` with `webhook_secret`), a pricing plan `POST /v1/agents/{agentId}/pricing-plans` (`model: "per_call"`, `price_amount` as a decimal string in USD), and `PATCH` with `listing_status: "live"`, which needs a live default plan.
  The handle becomes the agent's host: `https://<handle>.market.near.ai` serves its A2A card (`/.well-known/agent-card.json`) and endpoint (`/a2a/v1`).
- How work arrives.
  Polling `GET /v1/agents/me/assignments` every 30 to 60 s (each row carries the job brief and the latest thread message), or signed webhooks (`hire.created`, `hire.changes_requested`, `hire.accepted`, `hire.refunded`, `message.created`, `hire.disputed`, `hire.dispute_resolved`, `agent.suspended`, `webhook.ping`), HMAC-SHA256 of `<timestamp>.<raw body>` in `X-Market-Signature`, delivered at least once to a public HTTPS URL.
  No WebSocket is documented for workers.
  Work comes from bids on the job board (`POST /v1/jobs/{id}/bids`), instant hires, competitions, and paid A2A calls; this agent takes hires and A2A calls and places no bids.
- Accepting, delivering, getting paid.
  `POST /v1/assignments/{id}/start` (the buyer can no longer cancel), `POST /v1/assignments/{id}/submit` with `deliverableMarkdown` (up to 256 KiB) and `files`, or `POST /v1/assignments/{id}/decline` with `rejected` or `failed`, which refunds the buyer in full.
  Escrow is funded by the buyer at award and released to the owner's account after acceptance.
  On an A2A call, the caller's x402 payment (`X-PAYMENT`, x402 v2 `exact`) is verified and held as the escrow, settled when the agent delivers (the submit is accepted at once), and not settled when the agent declines or misses its window; the treasury sweep then pays the owner's share in USDC to their market account.
  [`/.well-known/x402`](https://market.near.ai/.well-known/x402) names one payee: `near:mainnet`, Circle's native USDC (`17208628f8...133a1`), so A2A payments are real mainnet USDC, signed as a NEP-366 delegate action for one `ft_transfer`.
  [`/v1/platform/config`](https://market.near.ai/v1/platform/config) reports `platform_fee_bps: 500` (5%).
- Authentication.
  `Authorization: Bearer aat_<32 hex>`, a token pinned to one agent that cannot act as its owner, read the owner's wallet, or move money.
  No NEAR account key is involved on the worker side; an A2A caller's wallet is its identity.
- Testnet or sandbox: none.
  The OpenAPI spec, the skills and `/.well-known/x402` mention no testnet, sandbox or staging host, and the only payment network is `near:mainnet`.
  The closest thing is an owner's free test run on the live market (a hire with zero escrow), which needs a live registration.

Older material describes a different design: the February 2026 [launch post](https://near.ai/blog/introducing-near-ai-agent-market) (payment in NEAR through escrow) and the archived [market-legacy.near.ai skill](https://market-legacy.near.ai/skill.md) (version 0.3.0, `sk_live_` keys, a NEAR testnet wallet per agent, WebSocket notifications).
This agent follows the current API only.

What could not be confirmed without a live registration:

- Whether an `aat_` token may set `webhook_url` and `webhook_secret`: the webhook reference says it gets `403 agent_token_scope_forbidden`, while the A2A flow shows a self-registered agent doing it.
  The listing script treats that step as optional, and the worker polls either way.
- How long an agent may stay silent before callers get `-32603 no reachable backend`: `last_seen_at` is stamped by agent-token requests and webhook answers, but the window is not documented.
  The worker polls every 15 s.
- Whether going live needs the owner to accept the Builder Agreement first (`POST /v1/legal/accept` refuses non-human callers): the script never accepts terms, and a refusal stops it before the listing goes live.
- How an A2A message becomes the job brief exactly (the caller skill says the first line is the title and the rest the brief), and whether an A2A assignment's `escrowToken` reads `USDC` or `USD` (plans are priced in USD and paid 1:1 in USDC; the worker accepts both by default).
- Whether the 5% platform fee applies to A2A calls.

## The trial hire

The market has no testnet, so the trial ran against the local stand-in (`scripts/standin.ts`), which implements the documented shapes this agent touches: the A2A card, the x402 quote and `X-PAYMENT`, `SendMessage`, `GetTask` and `CancelTask` with their error codes, the worker REST routes with their refusals, and signed webhooks.
Its facilitator settles on NEAR testnet instead of mainnet: a relayer submits the caller's signed `ft_transfer` of test USDC (`usdc.tredio.testnet`) to the deployment's treasury at delivery, and the transfer is checked in the receipts.
By design it differs from the market in that one origin serves both the A2A host and the REST API, and it delivers webhooks to localhost.

`TRIAL_RELAYER=tredio-demo.testnet bun scripts/trial.ts "Godzilla Minus Zero"` on 2026-11-09 at 18:35 UTC, with the worker in its own process against the local API:

- The caller (`tredio.testnet`) got the 402 quote (0.05 USDC to `tredio-treasury.testnet` on `near:testnet`, valid 720 s), signed the delegate action, and called again with `X-PAYMENT`.
- The stand-in opened the hire and sent the signed `hire.created` webhook; the worker started, answered and submitted; the task completed in 9.6 s.
- The answer: `topic:godzilla-minus-zero.2` at 99.88 points (Wikipedia 41.55 and Bluesky 58.33; GDELT older than its 2 h limit), registry checkpoint at 1794249214, oracle report `DQ4LEho76jUVWPn3QHb5NrBwNevLMb4inqJ7xCMF5Ny8` verified, NEAR AI review `5133101e...cd2b7` verified.
- Settlement: [`HHySCsjmf7wnSGmFQEx5u1hwF1xJZwELvQcxByRwJYHS`](https://testnet.nearblocks.io/txns/HHySCsjmf7wnSGmFQEx5u1hwF1xJZwELvQcxByRwJYHS), submitted by `tredio-demo.testnet`, moved 0.05 USDC from `tredio.testnet` (999.9 to 999.85) to `tredio-treasury.testnet` (2279.780632 to 2279.830632).

## Commands

```sh
pnpm install                                  # from the repository root
cp .env.example .env                          # MARKET_API_TOKEN at least
bun run start                                 # the worker (port 4800)
bun scripts/check.ts "World Cup"              # one answer, no market involved (--json for the object)
bun scripts/list.ts                           # print the listing requests; sends nothing
TRIAL_RELAYER=<account> bun scripts/trial.ts  # a settled trial hire on testnet against the stand-in
bun run test
bun run typecheck
docker build -f apps/agent-market/Dockerfile .   # from the repository root
```

## Publishing

Only the owner publishes, after their OK; the script refuses `--publish` unless `AGENT_MARKET_PUBLISH=yes` is set.
On the live market, callers pay in mainnet USDC for answers about Tredio's testnet deployment until mainnet is live; the listing's description says so.

1. Choose the account: sign in on [market.near.ai](https://market.near.ai), accept its terms, create a self-hosted agent with the handle `tredio-attention`, and mint its API token; put `MARKET_API_TOKEN` and `AGENT_MARKET_AGENT_ID` in `apps/agent-market/.env`.
   Without them the script registers the agent itself, writes its token to that `.env`, and prints a single-use adoption link for the owner.
2. Run the worker where it stays up (`bun run start`, or the Docker image) with that token, `BACKEND_URL` pointing at Tredio's API, and `PUBLIC_API_URL` at its public address.
   For webhooks, also set `MARKET_WEBHOOK_SECRET` (32 characters or more) and `WORKER_PUBLIC_URL` (the worker's public HTTPS origin).
3. Check the plan: `bun scripts/list.ts`.
4. Publish:

```sh
cd apps/agent-market
AGENT_MARKET_PUBLISH=yes bun scripts/list.ts --publish
```

The listing settings, all optional: `AGENT_MARKET_HANDLE` (`tredio-attention`), `AGENT_MARKET_NAME` (`Tredio attention check`), `AGENT_MARKET_CATEGORY` (`data`), `AGENT_MARKET_EMAIL`, `PRICE_USDC` (`0.05`, also the worker's own floor), `SLA_SECONDS` (`120`).
The script sends the profile, the webhook and its test ping (when set), the per-call plan (kept when an identical one exists), and `listing_status: "live"`, stopping at the first required step the market refuses.
The live card is then at `https://tredio-attention.market.near.ai/.well-known/agent-card.json`.

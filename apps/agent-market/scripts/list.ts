/**
 * The agent's listing on the NEAR AI Agent Market: prints every request that would publish it
 * (method, URL, body; the token and the webhook secret are never printed). Nothing is sent
 * unless the owner runs it with `--publish` and AGENT_MARKET_PUBLISH=yes.
 *
 *   bun scripts/list.ts                                   # print the plan
 *   AGENT_MARKET_PUBLISH=yes bun scripts/list.ts --publish  # publish (the owner, after their OK)
 *
 * Settings come from env (Bun reads apps/agent-market/.env): MARKET_URL, AGENT_MARKET_HANDLE,
 * AGENT_MARKET_NAME, AGENT_MARKET_CATEGORY, AGENT_MARKET_EMAIL, PRICE_USDC, SLA_SECONDS,
 * WORKER_PUBLIC_URL with MARKET_WEBHOOK_SECRET, and for an agent created on the website
 * MARKET_API_TOKEN with AGENT_MARKET_AGENT_ID (without them, the first step registers one).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUsdc, microUsdc } from "../src/config";
import { describeStep, listingSteps, loadListingConfig, publish, publishMode } from "../src/listing";

const ENV_FILE = join(import.meta.dir, "..", ".env");

/** Sets `key=value` in the agent's .env (gitignored), keeping every other line. */
function upsertEnv(values: Record<string, string>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${k}=${v}`);
  }
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

let mode: "print" | "publish";
try {
  mode = publishMode(process.argv.slice(2), process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const cfg = loadListingConfig(process.env);
const steps = listingSteps(cfg);
const price = formatUsdc(microUsdc(cfg.PRICE_USDC));

console.log(`Listing "${cfg.AGENT_MARKET_NAME}" (${cfg.AGENT_MARKET_HANDLE}) on ${cfg.MARKET_URL}: ${price} USDC a call, ${cfg.SLA_SECONDS} s window, category ${cfg.AGENT_MARKET_CATEGORY}.`);
console.log(cfg.MARKET_API_TOKEN ? `Existing agent ${cfg.AGENT_MARKET_AGENT_ID}, with its token.` : "No agent yet: the first request registers one.");
console.log(`A2A host once live: https://${cfg.AGENT_MARKET_HANDLE}.${new URL(cfg.MARKET_URL).host}/a2a/v1 (card at /.well-known/agent-card.json).`);
console.log(cfg.WORKER_PUBLIC_URL ? `Webhook: ${cfg.WORKER_PUBLIC_URL}/market/webhook.` : "No WORKER_PUBLIC_URL: no webhook, the worker polls.");
console.log("");
steps.forEach((s, i) => console.log(`--- ${i + 1}. ${s.id}\n${describeStep(s, cfg.MARKET_URL)}\n`));

if (mode === "print") {
  console.log("Nothing was sent. To publish, the owner runs: AGENT_MARKET_PUBLISH=yes bun scripts/list.ts --publish");
  process.exit(0);
}

const results = await publish(steps, {
  marketUrl: cfg.MARKET_URL,
  token: cfg.MARKET_API_TOKEN,
  agentId: cfg.AGENT_MARKET_AGENT_ID,
  price: cfg.PRICE_USDC,
  slaSeconds: cfg.SLA_SECONDS,
  onToken: (token, agentId) => {
    upsertEnv({ MARKET_API_TOKEN: token, AGENT_MARKET_AGENT_ID: agentId });
    console.log(`Registered agent ${agentId}; its token (${token.slice(0, 8)}...) is in ${ENV_FILE}.`);
  },
});
for (const r of results) console.log(`${r.id}: ${r.skipped ? "skipped (the plan already exists)" : `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`}`);
const failed = results.find((r) => !r.ok && !steps.find((s) => s.id === r.id)?.optional);
if (failed) {
  console.error(`Stopped at ${failed.id}: the market answered ${failed.status}.`);
  process.exit(1);
}
const adoption = results.find((r) => r.id === "adoption-code")?.body as { adoptionUrl?: string } | undefined;
if (adoption?.adoptionUrl) console.log(`The owner adopts the agent (single use, short-lived): ${adoption.adoptionUrl}`);
console.log(`Published. Card: https://${cfg.AGENT_MARKET_HANDLE}.${new URL(cfg.MARKET_URL).host}/.well-known/agent-card.json`);

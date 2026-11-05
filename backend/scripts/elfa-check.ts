/**
 * Checks every Elfa key the way the backend routes it: calls /v2/key-status and prints the masked
 * key, its route (host and port, never credentials), the HTTP status, the plan and the credits
 * left. One credit each at most, one key at a time with a random gap between keys
 * (ELFA_CHECK_GAP_MIN_SEC to ELFA_CHECK_GAP_MAX_SEC, 30 to 90 by default). Each row prints as it lands.
 *
 *   cd backend && bun scripts/elfa-check.ts      # reads its settings from .env
 */
import { HttpError } from "../src/sources/http";
import { elfaProxy, parseKeyStatus } from "../src/sources/elfa";
import { routeElfaKeys } from "../src/sources/elfa-proxies";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const keys = list(process.env.ELFA_API_KEYS);
const proxies = list(process.env.ELFA_PROXIES);
const base = (process.env.ELFA_API_BASE?.trim() || "https://api.elfa.ai").replace(/\/$/, "");

if (keys.length === 0) {
  console.log("ELFA_API_KEYS is empty: nothing to check.");
  process.exit(0);
}

if (proxies.length > 0 && new URL(base).hostname !== "api.elfa.ai") {
  console.log("ELFA_PROXIES carry requests to api.elfa.ai only; ELFA_API_BASE points elsewhere.");
  process.exit(1);
}
const routing = routeElfaKeys(keys, proxies);
console.log(`${keys.length} keys, ${proxies.length} proxies (by position)`);
if (routing.unused.length > 0) console.log(`unused proxies: ${routing.unused.join(", ")}`);

/** Elfa's own error code and message, never anything that could echo a key. */
function reason(body: string): string {
  try {
    const j = JSON.parse(body) as { code?: unknown; message?: unknown; error?: unknown };
    const text = [j.code, j.message ?? j.error].filter((x) => typeof x === "string").join(" ");
    return text.slice(0, 80);
  } catch {
    return body.trim() === "" ? "(empty body: likely the proxy's own refusal)" : "(not JSON)";
  }
}

const gapMin = Number(process.env.ELFA_CHECK_GAP_MIN_SEC ?? 30) * 1000;
const gapMax = Math.max(gapMin, Number(process.env.ELFA_CHECK_GAP_MAX_SEC ?? 90) * 1000);
const widths = [10, 24, 6, 18, 6, 6, 9, 0];
const print = (r: string[]) => console.log(r.map((cell, c) => (widths[c] ? cell.padEnd(widths[c]!) : cell)).join("  ").trimEnd());
print(["key", "proxy", "status", "plan", "used", "limit", "remaining", "note"]);
for (const skipped of routing.skipped) print([skipped, "none", "-", "-", "-", "-", "-", "not used: no proxy"]);
for (const [i, route] of routing.routes.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, gapMin + Math.random() * (gapMax - gapMin)));
  const m = routing.mapping[i]!;
  const row = [m.key, m.proxy];
  try {
    const url = `${base}/v2/key-status`;
    const res = await fetch(url, {
      headers: { "x-elfa-api-key": route.key, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      ...elfaProxy(new URL(base).host, url, route.proxy),
    });
    const body = await res.text();
    if (!res.ok) throw new HttpError("elfa", res.status, body);
    const s = parseKeyStatus(JSON.parse(body));
    const plan = s.plan ?? (s.free === true ? "free (by limit)" : s.free === false ? "paid (by limit)" : "unknown");
    row.push(String(res.status), plan, String(s.usedThisMonth ?? "?"), String(s.monthlyLimit ?? "?"), String(s.remaining ?? "?"), s.free === true ? "narratives off (paid-only)" : "");
  } catch (e) {
    if (e instanceof HttpError) row.push(String(e.status), "-", "-", "-", "-", reason(e.body));
    // Network errors may quote a URL: credentials are cut before printing.
    else row.push("error", "-", "-", "-", "-", (e instanceof Error ? e.message : String(e)).replace(/\/\/[^\s/@]+@/g, "//***@").slice(0, 80));
  }
  print(row);
}

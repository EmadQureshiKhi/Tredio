/**
 * Static security checks over the NEAR contracts, what a static analyzer run is for other smart
 * contract platforms. Read-only: it builds nothing on chain and needs no key. SECURITY.md records a run.
 *
 *   pnpm security
 *
 * - NEAR rules every contract must keep (they fail the run): overflow checks in the release
 *   profile, no `unsafe`, every callback `#[private]`, every token receiver checks which token
 *   called it, no `signer_account_id` in access control, no joint promise returned from a method.
 * - Clippy's security lints on the wasm the chain runs, counted per lint (informational: with
 *   overflow checks on, an arithmetic overflow reverts the transaction instead of wrapping).
 * - cargo-deny over the deployed wasm's dependencies (contracts/deny.toml: advisories, sources),
 *   and cargo-audit over the whole lock file for information, when they are installed.
 * Exits 1 when a rule or cargo-deny fails.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CONTRACTS = join(ROOT, "contracts");
const CRATES = ["account", "accounts", "book", "coin", "coins", "common", "curation", "outcomes", "perps", "registry", "usdc"];
const SECURITY_LINTS = ["arithmetic_side_effects", "as_conversions", "cast_possible_truncation", "expect_used", "indexing_slicing", "integer_division", "panic", "unwrap_used"];

type Line = { file: string; n: number; text: string };
/** Contract source lines, test modules left out (they are not deployed). */
const sources: Line[] = CRATES.flatMap((crate) => {
  const dir = join(CONTRACTS, crate, "src");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".rs") && f !== "tests.rs")
    .flatMap((f) => {
      const all = readFileSync(join(dir, f), "utf8").split("\n");
      // An inline `#[cfg(test)] mod tests { ... }` ends the deployed code; `mod tests;` only names another file.
      const cut = all.findIndex((l, i) => /^#\[cfg\(test\)\]/.test(l) && /^mod tests \{/.test(all[i + 1] ?? ""));
      return (cut >= 0 ? all.slice(0, cut) : all).map((text, i) => ({ file: `${crate}/src/${f}`, n: i + 1, text }));
    });
});
const at = (l: Line) => `${l.file}:${l.n}`;

let failed = false;
const rule = (name: string, offenders: string[], passDetail: string) => {
  failed ||= offenders.length > 0;
  console.log(`  ${offenders.length ? "FAIL" : "ok  "}  ${name.padEnd(52)} ${offenders.length ? offenders.slice(0, 6).join(", ") : passDetail}`);
};

console.log("\nNEAR rules");
const profile = readFileSync(join(CONTRACTS, "Cargo.toml"), "utf8");
rule("Release builds check arithmetic overflow", /\[profile\.release\][^[]*overflow-checks\s*=\s*true/.test(profile) ? [] : ["contracts/Cargo.toml"], "overflow-checks = true: an overflow reverts");
rule("No unsafe code", sources.filter((l) => /\bunsafe\b/.test(l.text) && !l.text.trim().startsWith("//")).map(at), `0 in ${sources.length} lines`);
const callbacks = sources.filter((l) => /^\s*pub fn (on_|after_)\w+/.test(l.text));
const byFile = new Map<string, Line[]>();
for (const l of sources) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);
const unguarded = callbacks.filter((c) => !byFile.get(c.file)!.slice(Math.max(0, c.n - 7), c.n - 1).some((l) => l.text.includes("#[private]")));
rule("Every callback is #[private]", unguarded.map(at), `${callbacks.length} callbacks`);
const receivers = sources.filter((l) => /fn (ft|mt)_on_transfer\(/.test(l.text));
const unchecked = receivers.filter((r) => !byFile.get(r.file)!.slice(r.n, r.n + 12).some((l) => /predecessor_account_id\(\)/.test(l.text)));
rule("Token receivers check the calling token", unchecked.map(at), `${receivers.length} receivers`);
rule("No signer_account_id in contract logic", sources.filter((l) => /signer_account_id\(\)/.test(l.text)).map(at), "access checks use predecessor_account_id");
// `a.and(b)` is fine inside a chain that ends in `.then(...)`; returning the joint promise itself is not.
const joint = sources.filter((l, i, all) => /\.and\(/.test(l.text) && !all.slice(i, i + 8).some((x) => x.file === l.file && /\.then\(/.test(x.text)));
rule("No joint promise returned from a method", joint.map(at), "every .and() is followed by .then()");

console.log("\nClippy security lints (wasm32, contract crates)");
const clippy = spawnSync(
  "cargo",
  [
    "clippy", "--locked", "--quiet", "--workspace", "--exclude", "tredio-sandbox-tests", "--exclude", "tredio-test-publisher", "--lib",
    "--target", "wasm32-unknown-unknown", "--message-format=json", "--", ...SECURITY_LINTS.flatMap((l) => ["-W", `clippy::${l}`]),
  ],
  { cwd: CONTRACTS, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);
const counts = new Map<string, number>();
for (const line of clippy.stdout.split("\n")) {
  if (!line.startsWith("{")) continue;
  const m = JSON.parse(line) as { reason?: string; message?: { code?: { code?: string } } };
  const code = m.reason === "compiler-message" ? m.message?.code?.code : undefined;
  if (code?.startsWith("clippy::")) counts.set(code.slice(8), (counts.get(code.slice(8)) ?? 0) + 1);
}
if (clippy.status !== 0) rule("Clippy ran", [`exit ${clippy.status}: ${clippy.stderr.trim().split("\n").pop()}`], "");
for (const lint of SECURITY_LINTS) console.log(`  ${String(counts.get(lint) ?? 0).padStart(5)}  ${lint}`);

console.log("\nDependencies");
const cargo = (args: string[]) => spawnSync("cargo", args, { cwd: CONTRACTS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const missing = (r: ReturnType<typeof cargo>) => Boolean(r.error) || /no such command/.test(r.stderr);
// cargo-deny decides, over the deployed wasm's dependencies (contracts/deny.toml).
const deny = cargo(["deny", "check", "advisories", "bans", "sources"]);
if (missing(deny)) console.log(`  skip  ${"cargo deny".padEnd(52)} not installed: cargo install --locked cargo-deny`);
else {
  const summary = `${deny.stdout}\n${deny.stderr}`.split("\n").map((l) => l.trim()).filter((l) => /^(advisories|bans|sources) /.test(l)).pop() ?? `exit ${deny.status}`;
  rule("cargo deny (wasm dependencies)", deny.status === 0 ? [] : [summary], summary);
}
// cargo-audit reads the whole lock file, test tooling included, for information.
const audit = cargo(["audit", "--json"]);
if (missing(audit)) console.log(`  skip  ${"cargo audit".padEnd(52)} not installed: cargo install --locked cargo-audit`);
else {
  const r = JSON.parse(audit.stdout) as { lockfile: { "dependency-count": number }; vulnerabilities: { list: Array<{ advisory: { id: string; package: string } }> }; warnings: Record<string, Array<{ advisory: { id: string; package: string } }>> };
  const ids = [...r.vulnerabilities.list, ...Object.values(r.warnings).flat()].map((v) => `${v.advisory.id} ${v.advisory.package}`);
  console.log(`  info  ${"cargo audit (whole lock file, tests included)".padEnd(52)} ${r.lockfile["dependency-count"]} crates; ${ids.length ? ids.join(", ") : "no advisories"}`);
}

console.log(failed ? "\nsecurity: a check failed" : "\nsecurity: every rule holds");
process.exit(failed ? 1 : 0);

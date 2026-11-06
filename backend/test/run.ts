import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DB_REQUIRED } from "./helpers";

/**
 * `bun run test` (and the root `pnpm test`): every test file here. The database files (those that
 * call `testDb()`) need TEST_DATABASE_URL. Without it they are skipped with a notice before and
 * after the run, as the Autopilot and indexer tests skip theirs, so the rest still runs on a machine
 * with no Postgres. Under CI a missing database is an error instead: a workflow that lost its
 * database must not pass with those files skipped. Arguments go to `bun test` unchanged, and
 * `bun test test/` still runs everything as before.
 */

const dir = import.meta.dir;
const args = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
const needsDb = files.filter((f) => /\btestDb\(/.test(readFileSync(join(dir, f), "utf8")));

// Files or patterns named on the command line are run as given (a database file still needs the database).
const named = args.some((a) => !a.startsWith("-"));
let targets = named ? [] : ["test/"];
let notice: string | null = null;
if (!process.env.TEST_DATABASE_URL && !named) {
  if (process.env.CI) {
    console.error(`backend tests: ${DB_REQUIRED}\nCI runs every database test, so the run stops here.`);
    process.exit(1);
  }
  targets = files.filter((f) => !needsDb.includes(f)).map((f) => `./test/${f}`);
  const bar = "!".repeat(100);
  notice = `${bar}\nSKIPPED ${needsDb.length} of ${files.length} backend test files that need a database: ${needsDb.map((f) => f.replace(/\.test\.ts$/, "")).join(", ")}.\n${DB_REQUIRED}\n${bar}`;
}

if (notice) console.warn(notice);
const run = Bun.spawnSync([process.execPath, "test", ...targets, ...args], { cwd: join(dir, ".."), stdio: ["inherit", "inherit", "inherit"] });
if (notice) console.warn(notice);
process.exit(run.exitCode ?? 1);

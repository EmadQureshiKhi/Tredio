/**
 * Runs Tredio locally against the testnet contracts, and keeps it running: the API, the services
 * and the app, with each process's output prefixed by its name.
 *
 *   pnpm dev                     everything that has a .env
 *   pnpm dev backend frontend    only these
 *
 * Each Bun process reads its own `.env` (copy the `.env.example` beside it); one without a
 * `.env` is skipped with a note. Ctrl-C stops them all.
 *
 * A supervisor: a process that exits is started again after a pause that doubles with each quick
 * failure (1 s up to a minute; one that ran ten minutes starts over at a second), and a process
 * that stops answering (its /live, or a Next page, three checks in a row, 15 s apart, after a
 * minute's grace) is stopped and started again. Each service reports when it started in /health,
 * so the status page shows a recent restart. Hosted, Docker does the same (deploy/docker-compose.yml).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface Proc {
  name: string;
  dir: string;
  cmd: string[];
  port: number;
  /** Reads `<dir>/.env` itself (Next.js), so no --env-file. */
  next?: boolean;
}

const PROCS: Proc[] = [
  { name: "backend", dir: "backend", cmd: ["bun", "--env-file=.env", "--hot", "src/index.ts"], port: 4000 },
  { name: "relayer", dir: "apps/relayer", cmd: ["bun", "--env-file=.env", "src/index.ts"], port: 4100 },
  { name: "keeper", dir: "apps/keeper", cmd: ["bun", "--env-file=.env", "src/index.ts"], port: 4200 },
  { name: "market-maker", dir: "apps/market-maker", cmd: ["bun", "--env-file=.env", "src/index.ts"], port: 4300 },
  { name: "autopilot", dir: "apps/autopilot", cmd: ["bun", "--env-file=.env", "src/index.ts"], port: 4400 },
  { name: "topup", dir: "apps/topup", cmd: ["bun", "--env-file=.env", "src/index.ts"], port: 4500 },
  { name: "oracle", dir: "apps/oracle", cmd: ["bun", "--env-file=.env", "src/index.ts"], port: 4600 },
  { name: "indexer", dir: "apps/indexer", cmd: ["bun", "--env-file=.env", "src/index.ts"], port: 4700 },
  { name: "frontend", dir: "frontend", cmd: ["node", "node_modules/next/dist/bin/next", "dev", "-p", "3000"], port: 3000, next: true },
  { name: "admin", dir: "admin", cmd: ["node", "node_modules/next/dist/bin/next", "dev", "-p", "3001"], port: 3001, next: true },
];

const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95];
const wanted = new Set(process.argv.slice(2));
const unknown = [...wanted].filter((w) => !PROCS.some((p) => p.name === w));
if (unknown.length) {
  console.error(`unknown: ${unknown.join(", ")}; choose from ${PROCS.map((p) => p.name).join(", ")}`);
  process.exit(2);
}

const width = Math.max(...PROCS.map((p) => p.name.length));
/** A process that ran this long counts as healthy: its next failure starts the pause over. */
const HEALTHY_RUN_MS = 10 * 60_000;
const MAX_PAUSE_MS = 60_000;
const CHECK_MS = 15_000;
const GRACE_MS = 60_000;
const MISSES = 3;

interface Child {
  p: Proc;
  prefix: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  startedAt: number;
  /** Quick failures in a row, for the pause before the next start. */
  failures: number;
  /** Health checks missed in a row. */
  misses: number;
  restarts: number;
}

const children: Child[] = [];
let stopping = false;

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) console.log(`${prefix} ${line}`);
  }
  if (buffer) console.log(`${prefix} ${buffer}`);
}

function start(c: Child) {
  const proc = Bun.spawn(c.p.cmd, { cwd: join(ROOT, c.p.dir), stdout: "pipe", stderr: "pipe", env: { ...process.env, PORT: String(c.p.port) } });
  c.proc = proc;
  c.startedAt = Date.now();
  c.misses = 0;
  console.log(`${c.prefix} started on :${c.p.port}${c.restarts ? ` (restart ${c.restarts})` : ""}`);
  void pipe(proc.stdout, c.prefix);
  void pipe(proc.stderr, c.prefix);
  void proc.exited.then((code) => {
    if (c.proc !== proc) return;
    c.proc = null;
    if (stopping) return;
    c.failures = Date.now() - c.startedAt >= HEALTHY_RUN_MS ? 1 : c.failures + 1;
    const pause = Math.min(MAX_PAUSE_MS, 1000 * 2 ** (c.failures - 1));
    c.restarts++;
    console.log(`${c.prefix} exited with ${code}; starting it again in ${pause / 1000} s`);
    setTimeout(() => {
      if (!stopping) start(c);
    }, pause);
  });
}

/** True when the process answers HTTP at all: its /live (Bun services) or its home page (Next). */
async function answers(c: Child): Promise<boolean> {
  const path = c.p.next ? "/" : "/live";
  try {
    const res = await fetch(`http://localhost:${c.p.port}${path}`, { signal: AbortSignal.timeout(5000) });
    return c.p.next ? res.status < 500 : res.ok;
  } catch {
    return false;
  }
}

PROCS.forEach((p, i) => {
  if (wanted.size && !wanted.has(p.name)) return;
  const env = p.next ? [".env.local", ".env"].find((f) => existsSync(join(ROOT, p.dir, f))) : existsSync(join(ROOT, p.dir, ".env")) ? ".env" : undefined;
  if (!env && !p.next) {
    console.log(`skip ${p.name}: no ${p.dir}/.env (copy ${p.dir}/.env.example and fill it in)`);
    return;
  }
  const c: Child = { p, prefix: `\x1b[${COLORS[i % COLORS.length]}m${p.name.padEnd(width)}\x1b[0m |`, proc: null, startedAt: 0, failures: 0, misses: 0, restarts: 0 };
  children.push(c);
  start(c);
});

if (!children.length) {
  console.log("nothing to run");
  process.exit(1);
}

setInterval(() => {
  for (const c of children) {
    if (!c.proc || Date.now() - c.startedAt < GRACE_MS) continue;
    void answers(c).then((ok) => {
      const proc = c.proc;
      if (!proc || stopping) return;
      if (ok) {
        c.misses = 0;
        return;
      }
      c.misses++;
      if (c.misses < MISSES) return;
      console.log(`${c.prefix} not answering for ${MISSES} checks; stopping it to start it again`);
      c.misses = 0;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (c.proc === proc) proc.kill("SIGKILL");
      }, 10_000);
    });
  }
}, CHECK_MS);

const stop = () => {
  stopping = true;
  for (const c of children) c.proc?.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});

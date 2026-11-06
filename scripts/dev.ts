/**
 * Runs Tredio locally against the testnet contracts: the API, the services and the app, with
 * each process's output prefixed by its name.
 *
 *   pnpm dev                     everything that has a .env
 *   pnpm dev backend frontend    only these
 *
 * Each Bun process reads its own `.env` (copy the `.env.example` beside it); one without a
 * `.env` is skipped with a note. Ctrl-C stops them all.
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
  { name: "frontend", dir: "frontend", cmd: ["npx", "next", "dev", "-p", "3000"], port: 3000, next: true },
  { name: "admin", dir: "admin", cmd: ["npx", "next", "dev", "-p", "3001"], port: 3001, next: true },
];

const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95];
const wanted = new Set(process.argv.slice(2));
const unknown = [...wanted].filter((w) => !PROCS.some((p) => p.name === w));
if (unknown.length) {
  console.error(`unknown: ${unknown.join(", ")}; choose from ${PROCS.map((p) => p.name).join(", ")}`);
  process.exit(2);
}

const width = Math.max(...PROCS.map((p) => p.name.length));
const running: Array<{ name: string; proc: ReturnType<typeof Bun.spawn> }> = [];

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

PROCS.forEach((p, i) => {
  if (wanted.size && !wanted.has(p.name)) return;
  const env = p.next ? [".env.local", ".env"].find((f) => existsSync(join(ROOT, p.dir, f))) : existsSync(join(ROOT, p.dir, ".env")) ? ".env" : undefined;
  if (!env && !p.next) {
    console.log(`skip ${p.name}: no ${p.dir}/.env (copy ${p.dir}/.env.example and fill it in)`);
    return;
  }
  const prefix = `\x1b[${COLORS[i % COLORS.length]}m${p.name.padEnd(width)}\x1b[0m |`;
  const proc = Bun.spawn(p.cmd, { cwd: join(ROOT, p.dir), stdout: "pipe", stderr: "pipe", env: { ...process.env, PORT: String(p.port) } });
  running.push({ name: p.name, proc });
  console.log(`${prefix} started on :${p.port}`);
  void pipe(proc.stdout, prefix);
  void pipe(proc.stderr, prefix);
  void proc.exited.then((code) => console.log(`${prefix} exited with ${code}`));
});

if (!running.length) {
  console.log("nothing to run");
  process.exit(1);
}

const stop = () => {
  for (const r of running) r.proc.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.all(running.map((r) => r.proc.exited));

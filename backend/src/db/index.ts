import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql;

/**
 * TLS for `url`: what its `sslmode` asks for, else none for this machine or a host on the Compose
 * network (a name without a dot, like `postgres`), and required for any other, hosted, database.
 */
export function sslFor(url: string): false | "allow" | "prefer" | "require" | "verify-full" {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (mode === "disable") return false;
  if (mode === "allow" || mode === "prefer" || mode === "require" || mode === "verify-full") return mode;
  if (mode === "verify-ca") return "require";
  const host = u.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || !host.includes(".") ? false : "require";
}

/** A client for `url`, with TLS as `sslFor` decides. */
export function connect(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: sslFor(url),
    // Poolers in transaction mode do not keep prepared statements across connections.
    prepare: false,
    onnotice: () => {},
  });
}

/** Applies every migration in order; each is idempotent, so this runs on every start. */
export async function migrate(sql: Sql): Promise<string[]> {
  const dir = join(import.meta.dir, "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) await sql.unsafe(readFileSync(join(dir, file), "utf8"));
  return files;
}

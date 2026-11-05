import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql;

/** A client for `url`. Local databases skip TLS; hosted ones require it. */
export function connect(url: string, max = 10): Sql {
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  return postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: local ? false : "require",
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

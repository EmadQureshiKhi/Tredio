import { type Config, loadConfig } from "./config";
import { connect, lockSchema, migrate, type Sql } from "./db";
import { DEFAULT_START_BLOCK, deploymentsPath, loadDeployment, Tracker } from "./deployments";
import { createLog, type Log } from "./log";
import { otherNetworks } from "./store";

export interface Runtime {
  cfg: Config;
  log: Log;
  sql: Sql;
  tracker: Tracker;
  startBlock: number;
  release: () => Promise<void>;
}

/**
 * Configuration, deployment, database (migrated) and the schema lock, shared by the indexer and
 * the resync command. Fails when another process holds the lock or the schema belongs to
 * another network.
 */
export async function setup(env: Record<string, string | undefined> = process.env): Promise<Runtime> {
  const cfg = loadConfig(env);
  const log = createLog(cfg.LOG_LEVEL);
  const deployment = loadDeployment(cfg.DEPLOYMENTS_FILE ?? deploymentsPath(cfg.NETWORK));
  if (deployment.network !== cfg.NETWORK) throw new Error(`the deployments file is for ${deployment.network}, NETWORK is ${cfg.NETWORK}`);
  const startBlock = cfg.START_BLOCK ?? deployment.startBlock ?? DEFAULT_START_BLOCK[cfg.NETWORK];
  if (!startBlock) throw new Error(`set START_BLOCK: there is no default start block for ${cfg.NETWORK}`);
  const sql = connect(cfg.DATABASE_URL, cfg.INDEXER_SCHEMA);
  try {
    // The lock comes first, so two processes never run the migrations at once.
    const release = await lockSchema(sql, cfg.INDEXER_SCHEMA);
    if (!release) throw new Error(`another indexer process holds schema "${cfg.INDEXER_SCHEMA}"; stop it first`);
    try {
      await migrate(sql, cfg.INDEXER_SCHEMA);
      const others = await otherNetworks(sql, cfg.NETWORK);
      if (others.length) throw new Error(`schema "${cfg.INDEXER_SCHEMA}" already holds ${others.join(", ")} data; use another INDEXER_SCHEMA`);
    } catch (e) {
      await release();
      throw e;
    }
    return { cfg, log, sql, tracker: new Tracker(deployment), startBlock, release };
  } catch (e) {
    await sql.end({ timeout: 5 });
    throw e;
  }
}

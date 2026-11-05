/** One JSON line per message on stdout (stderr for errors), with a level filter from LOG_LEVEL. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

export interface Log {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLog(level: Level = "info"): Log {
  const min = LEVELS[level];
  const write = (l: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[l] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: l, msg, ...fields }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v instanceof Error ? v.message : v,
    );
    (l === "error" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

/** A log that drops everything, for tests. */
export const silentLog: Log = { debug() {}, info() {}, warn() {}, error() {} };

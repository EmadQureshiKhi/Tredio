import { Hono } from "hono";
import type { IngestStatus } from "./ingest";

export interface HealthOptions {
  status: () => IngestStatus;
  /** False once the loop has ended. */
  running: () => boolean;
  maxLagSec: number;
  liveTimeoutSec: number;
  now?: () => number;
}

/** `/health`: 200 while the indexed block is less than `maxLagSec` old. `/live`: 200 while the loop runs. */
export function healthApp(o: HealthOptions): Hono {
  const now = o.now ?? Date.now;
  const app = new Hono();
  app.get("/health", (c) => {
    const s = o.status();
    const lagSec = s.blockTime ? Math.max(0, Math.round((now() - s.blockTime.getTime()) / 1000)) : null;
    const ok = o.running() && lagSec !== null && lagSec < o.maxLagSec;
    return c.json(
      {
        ok,
        height: s.height,
        head: s.head,
        lagBlocks: Math.max(0, s.head - s.height),
        lagSec,
        eventsProcessed: s.eventsProcessed,
        startedAt: s.startedAt.toISOString(),
      },
      ok ? 200 : 503,
    );
  });
  app.get("/live", (c) => {
    const s = o.status();
    const alive = o.running() && now() - s.beat < o.liveTimeoutSec * 1000;
    return c.json({ ok: alive }, alive ? 200 : 503);
  });
  return app;
}

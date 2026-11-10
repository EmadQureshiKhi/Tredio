import { Hono } from "hono";
import type { IngestStatus } from "./ingest";

export interface HealthOptions {
  status: () => IngestStatus;
  /** False once the loop has ended. */
  running: () => boolean;
  maxLagSec: number;
  liveTimeoutSec: number;
  /** The feed's FastNEAR API keys: how many were configured and how many it dropped after a refusal. */
  keys?: { configured: number; refused: () => number };
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
    // Why it is not ok, or what to fix, in words the status page shows ("lag: 100 s behind the chain").
    const alerts: Record<string, string> = {};
    if (!o.running()) alerts.stopped = "not following the chain";
    else if (lagSec === null) alerts.lag = "no block read yet";
    else if (lagSec >= o.maxLagSec) alerts.lag = `${lagSec} s behind the chain`;
    // A refused key does not stop the feed (it goes on with the others, or without one), but it is worth fixing.
    const refused = o.keys?.refused() ?? 0;
    if (o.keys && refused > 0) {
      alerts.keys = refused >= o.keys.configured ? "FastNEAR refused the API key; reading at the keyless rate" : `FastNEAR refused ${refused} of ${o.keys.configured} API keys`;
    }
    return c.json(
      {
        ok,
        alerts,
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

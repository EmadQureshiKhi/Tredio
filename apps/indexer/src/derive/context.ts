import type { z } from "zod";
import type { Tx } from "../db";
import type { Tracker } from "../deployments";
import type { StoredEvent } from "../extract";

/** What a handler sees: the transaction, the event, the other events of its receipt. */
export interface Ctx {
  tx: Tx;
  e: StoredEvent;
  /** Every stored event of the same receipt, in log order (the event itself included). */
  receipt: StoredEvent[];
  tracker: Tracker;
}

export interface Handler {
  schema: z.ZodType;
  run: (c: Ctx, data: never) => Promise<void>;
}

/** A handler for events of one shape; `run` gets the validated data. */
export function on<S extends z.ZodType>(schema: S, run: (c: Ctx, data: z.infer<S>) => Promise<void>): Handler {
  return { schema, run: run as Handler["run"] };
}

/** Unix seconds as a timestamp. */
export const secs = (s: number) => new Date(s * 1000);

/** A raw integer as numeric text (never a JS bigint parameter, which Postgres would type as int8). */
export const num = (v: bigint | number | string) => v.toString();

import pino from "pino";
import { backendErrors } from "./errors";

/** Pino's numeric level for warn: warnings and errors also go to the admin system view's recent errors. */
const WARN = 40;

/** "measurement failed: elfa: HTTP 429", from a log call's message and its error field. */
function describe(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first === "string") return first;
  const fields = (first ?? {}) as Record<string, unknown>;
  const detail = [fields.job, fields.source, fields.provider, fields.err ?? fields.error].filter((x) => typeof x === "string" && x).join(": ");
  const msg = typeof second === "string" ? second : "";
  return detail ? `${msg}: ${detail}` : msg;
}

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "backend" },
  hooks: {
    logMethod(args, method, level) {
      if (level >= WARN) backendErrors.note("backend", describe(args));
      return method.apply(this, args);
    },
  },
});
export type Log = typeof log;

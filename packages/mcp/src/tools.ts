/** What every tool shares: argument shapes, series windows, and the wrapper that turns answers and errors into MCP results. */
import { z } from "zod";

export const identifier = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9:._-]{1,64}$/, "a trend identifier such as topic:world-cup");
export const account = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "a NEAR account id")
  .min(2)
  .max(64);

export const WINDOWS = { "15m": 900, "24h": 86_400, "7d": 604_800 } as const;
export type WindowName = keyof typeof WINDOWS;
export const windowName = (sec: number) => (Object.entries(WINDOWS).find(([, s]) => s === sec)?.[0] ?? `${sec}s`) as string;

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
export const run =
  <A>(fn: (args: A) => Promise<Record<string, unknown>>) =>
  async (args: A): Promise<Result> => {
    try {
      const data = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (e) {
      return { content: [{ type: "text", text: String((e as Error).message ?? e) }], isError: true };
    }
  };

/** JSON lines on stdout, as the other Tredio services log. */
export interface Log {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export function jsonLog(service: string): Log {
  const line = (level: string) => (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service, level, msg, ...fields }));
  return { info: line("info"), warn: line("warn"), error: line("error") };
}

export const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} };

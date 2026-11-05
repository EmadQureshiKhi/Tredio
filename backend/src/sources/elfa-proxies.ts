import { keyId } from "../budget";

/**
 * Pairs ELFA_API_KEYS with ELFA_PROXIES by position. Keys and route credentials never reach a log:
 * keys show as their last four characters, routes as host and port (proxyHost).
 */

export interface ElfaRoute {
  key: string;
  keyId: string;
  /** The key's route URL, credentials included. */
  proxy: string;
}

export interface ElfaRouting {
  /** Keys that may call Elfa, with their routes. */
  routes: ElfaRoute[];
  /** Keys left out because they have no route (masked). */
  skipped: string[];
  /** What to log: masked key and route host. */
  mapping: Array<{ key: string; proxy: string }>;
  /** Routes no key uses (more routes than keys), by host. */
  unused: string[];
}

/** A key as its last four characters. */
export const maskKey = (key: string) => `...${key.slice(-4)}`;

/**
 * A route URL as host and port, plus its username's last four characters when it has one. Never
 * the password; an unparsable URL shows as "invalid proxy".
 */
export function proxyHost(proxy: string): string {
  try {
    const u = new URL(proxy);
    const host = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
    const user = decodeURIComponent(u.username);
    return user ? `${host} (user ${maskKey(user)})` : host;
  } catch {
    return "invalid proxy";
  }
}

/** Checks one route URL; the error names the entry by position, never its text (it holds credentials). */
export function validProxy(proxy: string, i: number): URL {
  let u: URL;
  try {
    u = new URL(proxy);
  } catch {
    throw new Error(`ELFA_PROXIES entry ${i + 1} is not a URL (expected http://user:pass@host:port)`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`ELFA_PROXIES entry ${i + 1} must be an http:// or https:// proxy`);
  if (!u.hostname) throw new Error(`ELFA_PROXIES entry ${i + 1} needs a host`);
  return u;
}

/** Pairs keys and routes by position. Two entries naming the same route are refused. */
export function routeElfaKeys(keys: readonly string[], proxies: readonly string[]): ElfaRouting {
  const seen = new Map<string, number>();
  proxies.forEach((p, i) => {
    const u = validProxy(p, i);
    const id = `${decodeURIComponent(u.username)}@${u.hostname}:${u.port || u.protocol}`;
    const first = seen.get(id);
    if (first !== undefined) throw new Error(`ELFA_PROXIES entries ${first + 1} and ${i + 1} are the same proxy; each key needs its own`);
    seen.set(id, i);
  });
  const routes: ElfaRoute[] = [];
  const skipped: string[] = [];
  keys.forEach((key, i) => {
    const proxy = proxies[i];
    if (proxy === undefined) skipped.push(maskKey(key));
    else routes.push({ key, keyId: keyId(key), proxy });
  });
  return {
    routes,
    skipped,
    mapping: routes.map((r) => ({ key: maskKey(r.key), proxy: proxyHost(r.proxy) })),
    unused: proxies.slice(keys.length).map(proxyHost),
  };
}

import { isIP } from "node:net";
import type { Context, Env, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

/**
 * Fixed-window request limits per key, in memory (one backend instance). The key is usually the
 * client IP (`byIp`); routes for signed-in accounts may key on the account instead.
 */
export function rateLimit<E extends Env = Env>(limit: number, windowMs: number, key: (c: Context<E>) => string, now: () => number = Date.now): MiddlewareHandler<E> {
  const hits = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    const k = key(c);
    const h = hits.get(k);
    if (!h || t - h.start >= windowMs) hits.set(k, { start: t, count: 1 });
    else if (++h.count > limit) {
      c.header("retry-after", String(Math.ceil((h.start + windowMs - t) / 1000)));
      return c.json({ error: "too many requests" }, 429);
    }
    await next();
  };
}

/** Keys a rate limit on the client IP; see `clientIp`. */
export const byIp =
  (trustedProxyHops: number) =>
  <E extends Env>(c: Context<E>): string =>
    `ip:${clientIp(c, trustedProxyHops)}`;

/**
 * The caller's address, the one helper every IP limit uses. With no trusted proxy (`hops` 0) it is
 * the socket's peer. Behind proxies that each append the address they saw to X-Forwarded-For, it is
 * the entry `hops` positions from the right: entries further left were written by the client and
 * prove nothing. A request with fewer entries than that did not pass the proxies, so its socket
 * counts. IPv6 addresses count per /64, the block one subscriber usually holds.
 */
export function clientIp<E extends Env>(c: Context<E>, trustedProxyHops: number): string {
  let ip: string | undefined;
  if (trustedProxyHops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    ip = chain[chain.length - trustedProxyHops];
  }
  ip ??= socketAddress(c);
  return ip ? rateKey(ip) : "unknown";
}

/** The socket peer from Bun's server (Hono's connection info); undefined outside Bun.serve. */
function socketAddress<E extends Env>(c: Context<E>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** One key per client: IPv4-mapped IPv6 as plain IPv4, and other IPv6 addresses by their /64. */
export function rateKey(ip: string): string {
  const bare = ip.replace(/%.*$/, "").toLowerCase();
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1]!;
  if (isIP(bare) !== 6) return bare.slice(0, 64);
  return `${expandIpv6(bare).slice(0, 4).join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, zero-padded. */
function expandIpv6(ip: string): string[] {
  let s = ip;
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? null : tail ? tail.split(":") : [];
  const groups = right === null ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((g) => g.padStart(4, "0"));
}

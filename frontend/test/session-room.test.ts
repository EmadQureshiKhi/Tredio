import { describe, expect, test } from "bun:test";
import { MAX_SESSIONS, sessionsToRetire } from "../src/lib/account/session-room";

const NOW = 1_000_000;
const slots = (n: number, expiresAt: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ publicKey: `k${i}`, expiresAt: expiresAt(i) }));

describe("room for a new session", () => {
  test("retires nothing while there is room", () => {
    expect(sessionsToRetire(slots(MAX_SESSIONS - 1, () => NOW + 10), [], NOW)).toEqual([]);
  });

  test("at the limit, retires expired sessions before live ones", () => {
    const s = slots(MAX_SESSIONS, (i) => (i === 7 ? NOW - 5 : NOW + 100 + i));
    expect(sessionsToRetire(s, [], NOW)).toEqual(["k7"]);
  });

  test("with none expired, retires the session closest to expiring, never the one being renewed", () => {
    const s = slots(MAX_SESSIONS, (i) => NOW + 100 + i);
    expect(sessionsToRetire(s, [], NOW)).toEqual(["k0"]);
    expect(sessionsToRetire(s, [], NOW, "k0")).toEqual(["k1"]);
  });

  test("dormant keys count toward the limit and go first", () => {
    const s = slots(MAX_SESSIONS - 2, () => NOW + 50);
    expect(sessionsToRetire(s, ["d1", "d2"], NOW)).toEqual(["d1"]);
  });

  test("an account past the limit retires enough to fit one more", () => {
    expect(sessionsToRetire(slots(MAX_SESSIONS + 2, (i) => NOW + i), [], NOW)).toHaveLength(3);
  });
});

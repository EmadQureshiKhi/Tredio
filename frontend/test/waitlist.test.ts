import { describe, expect, test } from "bun:test";
import { EMAIL, emailError, shortEmail } from "../src/features/waitlist/email";
import { WAITLIST_HINT_SCRIPT, WAITLIST_KEY, waitlistTokens } from "../src/features/waitlist/hint";
import { joinedFor, readMemory } from "../src/features/waitlist/store";

describe("waitlist email", () => {
  test("refuses what the backend refuses, with a reason the form shows", () => {
    expect(emailError("")).toBe("Enter your email address.");
    expect(emailError("   ")).toBe("Enter your email address.");
    expect(emailError("nope")).toBe("Enter a valid email address.");
    expect(emailError("a@b")).toBe("Enter a valid email address.");
    expect(emailError(`${"a".repeat(60)}@${"b".repeat(200)}.com`)).toBe("That email address is too long.");
    expect(emailError(" Waitlist-Check+1@Tredio.BID ")).toBeNull();
    expect(EMAIL.test("a@xn--80ak6aa92e.xn--p1ai")).toBe(true);
  });

  test("shortens a long address and keeps the domain whole", () => {
    expect(shortEmail("me@tredio.bid")).toBe("me@tredio.bid");
    expect(shortEmail("waitlist-check+1791838482156@tredio.bid")).toBe("waitlist-check…@tredio.bid");
  });
});

describe("waitlist memory", () => {
  test("reads what this browser stored and shrugs off anything malformed", () => {
    const empty = { joined: [], rowDismissed: false, cardCollapsed: false };
    expect(readMemory(null)).toEqual(empty);
    expect(readMemory("{not json")).toEqual(empty);
    expect(readMemory(JSON.stringify({ joined: [{ email: "a@b.co", at: 1 }, { email: 3 }], rowDismissed: "yes", cardCollapsed: true }))).toEqual({
      joined: [{ email: "a@b.co", account: null, at: 1 }],
      rowDismissed: false,
      cardCollapsed: true,
    });
  });

  test("names the email an account linked, else the latest join", () => {
    const memory = readMemory(JSON.stringify({ joined: [{ email: "new@b.co", account: null, at: 2 }, { email: "old@b.co", account: "account-ab", at: 1 }], rowDismissed: false }));
    expect(joinedFor(memory, "Account-AB")?.email).toBe("old@b.co");
    expect(joinedFor(memory, "account-cd")?.email).toBe("new@b.co");
    expect(joinedFor(memory, undefined)?.email).toBe("new@b.co");
    expect(joinedFor(null, "account-ab")).toBeNull();
    expect(joinedFor(readMemory(null), "account-ab")).toBeNull();
  });

  test("the pre-paint hint reads the same key and marks the same states", () => {
    expect(WAITLIST_HINT_SCRIPT).toContain(`localStorage.getItem("${WAITLIST_KEY}")`);
    const html = (stored: unknown) => {
      const dataset: Record<string, string> = {};
      const localStorage = { getItem: () => JSON.stringify(stored) };
      new Function("localStorage", "document", WAITLIST_HINT_SCRIPT)(localStorage, { documentElement: { dataset } });
      return dataset.waitlist;
    };
    for (const m of [
      { joined: [], rowDismissed: false, cardCollapsed: false },
      { joined: [{}], rowDismissed: false, cardCollapsed: true },
      { joined: [], rowDismissed: true, cardCollapsed: true },
      { joined: [], rowDismissed: false, cardCollapsed: true },
    ]) {
      expect(html(m)).toBe(waitlistTokens(m) || undefined);
    }
    expect(waitlistTokens({ joined: [{}], rowDismissed: true, cardCollapsed: true })).toBe("joined row-dismissed card-collapsed");
  });
});

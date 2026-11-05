import type { Page } from "@playwright/test";
import { expect, LIVE, test } from "./live";

/**
 * The Mainnet waitlist against the running app and backend: signed out from the sidebar card
 * (its X folds it to a button, remembered across a reload; a bad email and a missing consent are
 * refused in the form, a good one joins and the card turns into "On the waitlist", also after a
 * reload), and signed in from the account sheet with the account linked.
 * Each run joins with new waitlist-check+<time>@tredio.bid addresses and leaves those rows in place
 * (the backend has no public delete, and the spec touches no other row); it clears only its own
 * waitlist memory in the shared live profile. Two joins per run stay well under the backend's
 * per-address limit.
 */

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");

const testEmail = (tag: string) => `waitlist-check+${Date.now()}-${tag}@tredio.bid`;

/** Joins through the open sheet and returns the body the app sent. */
async function join(page: Page, email: string): Promise<Record<string, unknown>> {
  const sheet = page.getByTestId("waitlist-sheet");
  await page.getByTestId("waitlist-email").fill(email);
  await page.getByTestId("waitlist-consent").check();
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/v1/waitlist"));
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/v1/waitlist"));
  await page.getByTestId("waitlist-submit").click();
  expect((await response).status()).toBe(200);
  await expect(sheet.getByTestId("waitlist-success")).toContainText(email);
  await expect(sheet.getByRole("heading", { name: "You’re on the list" })).toBeVisible();
  return JSON.parse((await request).postData() ?? "{}") as Record<string, unknown>;
}

test("signed out: the sidebar card folds away, refuses bad input, joins, and collapses", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/");
  const card = page.getByTestId("waitlist-card");
  await expect(card).toContainText("Mainnet is coming");
  // The X folds the card into a button that still opens the waitlist, and the browser remembers it.
  await card.getByRole("button", { name: "Hide the waitlist offer" }).click();
  const compact = page.getByTestId("waitlist-compact");
  await expect(compact).toBeFocused();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(compact).toBeVisible();
  await expect(page.getByTestId("waitlist-card")).toBeHidden();
  await compact.click();
  const sheet = page.getByTestId("waitlist-sheet");
  await expect(sheet.getByRole("heading", { name: "Join the Mainnet waitlist" })).toBeVisible();
  // Signed out, there is no account to link.
  await expect(sheet.getByRole("switch", { name: "Link my Tredio account" })).toHaveCount(0);

  // Refused in the form, before anything is sent.
  let sent = 0;
  page.on("request", (r) => r.url().endsWith("/v1/waitlist") && r.method() === "POST" && sent++);
  await page.getByTestId("waitlist-email").fill("not-an-email");
  await page.getByTestId("waitlist-submit").click();
  await expect(sheet.getByText("Enter a valid email address.")).toBeVisible();
  await expect(sheet.getByText("Tick the box to get the launch email.")).toBeVisible();
  expect(sent).toBe(0);

  const email = testEmail("out");
  const body = await join(page, email);
  expect(body).toEqual({ email, account: null, consent: true, website: "", source: "app" });

  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  // A join wins over the folded card.
  await expect(page.getByTestId("waitlist-joined")).toContainText("On the waitlist");
  await expect(compact).toHaveCount(0);
  await expect(card).toHaveCount(0);
  // The browser remembers: the compact card is there from the first paint after a reload.
  await page.reload();
  await expect(page.getByTestId("waitlist-joined")).toBeVisible();
  await expect(page.getByTestId("waitlist-card")).toBeHidden();
  await expect(compact).toBeHidden();
  // Opening it again shows the join, with a way to add another email.
  await page.getByTestId("waitlist-joined").click();
  await expect(sheet.getByTestId("waitlist-success")).toContainText(email);
  await expect(sheet.getByRole("button", { name: "Add another email" })).toBeVisible();
  await context.close();
});

test("signed in on a phone: the account sheet opens the waitlist and links the account", async ({ live, account }) => {
  const { page } = live;
  await page.evaluate(() => localStorage.removeItem("tredio.waitlist"));
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto("/");
    // The Home row offers it on phones.
    await expect(page.getByTestId("waitlist-row")).toBeVisible();
    await page.locator("header").getByRole("button").last().click();
    const accountSheet = page.getByTestId("account-sheet");
    await expect(accountSheet.getByTestId("account-address")).toBeVisible();
    await accountSheet.getByTestId("waitlist-entry").click();
    await expect(accountSheet).toBeHidden();
    const sheet = page.getByTestId("waitlist-sheet");
    const link = sheet.getByRole("switch", { name: "Link my Tredio account" });
    await expect(link).toHaveAttribute("aria-checked", "true");

    const email = testEmail("in");
    const body = await join(page, email);
    expect(body).toEqual({ email, account, consent: true, website: "", source: "app" });
    await expect(sheet.getByTestId("waitlist-success")).toContainText(`${account.slice(0, 6)}...${account.slice(-4)}`);
    await sheet.getByRole("button", { name: "Done" }).click();
    // Joined: the Home row is gone.
    await expect(page.getByTestId("waitlist-row")).toHaveCount(0);
  } finally {
    await page.evaluate(() => localStorage.removeItem("tredio.waitlist"));
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});

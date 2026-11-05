import { CALLER_BIO, callerHandle } from "./content";
import { expect, LIVE, passkeyUses, test, withIdentity } from "./live";

/**
 * The social layer and private data on the live Testnet stack: a signed caller profile, a call on
 * a live trend that shows on the profile and the leaderboard, linking the caller to the trading
 * account (the caller key signs, the passkey approves), a vault note sealed on the device, and push
 * notifications.
 */

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");

test("profile, a call on a live trend, linking, a sealed note and notifications", async ({ live, account }) => {
  const { page } = live;
  const handle = callerHandle();

  // A signed profile: handle and bio, no passkey prompt.
  await page.goto("/settings#identity");
  const identity = page.getByTestId("settings-identity");
  await withIdentity(page, page.getByTestId("profile-form"));
  const caller = (await identity.getByTestId("identity-address").getAttribute("data-address"))!;
  expect(caller).toMatch(/^[a-z0-9._:-]{2,128}$/);
  expect(caller).not.toBe(account.toLowerCase());
  await page.getByTestId("profile-handle").fill(handle.toUpperCase());
  await expect(page.getByTestId("profile-handle")).toHaveValue(handle);
  await page.getByTestId("profile-bio").fill(CALLER_BIO);
  await page.getByTestId("profile-save").click();
  await expect(page.getByText("Profile saved")).toBeVisible();
  await expect(identity.getByText(`@${handle}`)).toBeVisible();

  // A call on a live trend, signed by the caller identity.
  await page.goto("/leaders");
  await page.getByTestId("make-call").click();
  const sheet = page.getByTestId("call-sheet");
  await expect(sheet).toBeVisible();
  await withIdentity(page, page.getByTestId("call-submit"));
  const trend = await page.getByTestId("call-trend").inputValue();
  expect(trend).not.toBe("");
  await sheet.getByRole("radio", { name: "Down" }).click();
  await page.getByTestId("call-note").fill("Attention fades after the first spike.");
  await page.getByTestId("call-submit").click();
  await expect(page.getByTestId("call-done")).toBeVisible();
  await sheet.getByRole("link", { name: "See it on your profile" }).click();

  // On the profile, open, with its opening index.
  await expect(page.getByTestId("caller-name")).toHaveText(`@${handle}`);
  const call = page.locator(`[data-testid="call-row"][data-trend="${trend}"]`).first();
  await expect(call).toHaveAttribute("data-outcome", "open");
  await expect(call).toContainText("Down on");
  await expect(call).toContainText("Attention fades after the first spike.");
  await expect(page.getByTestId("caller-stats")).toContainText("Open");

  // On the leaderboard, with one open call.
  await page.goto("/leaders");
  const line = page.locator(`[data-testid="caller-line"][data-caller="${caller}"]`);
  await expect(line).toBeVisible();
  await expect(line).toContainText(`@${handle}`);

  // Linking the identity to the trading account: the caller key signs and the passkey approves (one
  // prompt); it is public and permanent.
  await page.goto("/settings#identity");
  await withIdentity(page, page.getByTestId("link-block"));
  await expect(page.getByTestId("link-block")).toContainText("Your caller key signs it and your passkey approves it.");
  await expect(page.getByTestId("link-submit")).toBeDisabled();
  await page.getByTestId("link-understood").check();
  const linking = await passkeyUses(live);
  await page.getByTestId("link-submit").click();
  await expect(page.getByTestId("link-status")).toHaveAttribute("data-linked", account.toLowerCase());
  expect(await passkeyUses(live)).toBe(linking + 1);
  await page.goto(`/c/${handle}`);
  await expect(page.getByTestId("trading-record")).toBeVisible();

  // A vault note: sealed here, only ciphertext on the server, opened again after a reload.
  await page.goto("/settings#notes");
  await withIdentity(page, page.getByTestId("note-new"));
  const title = `Thesis ${Date.now().toString(36)}`;
  await page.getByTestId("note-new").click();
  await page.getByTestId("note-title").fill(title);
  await page.getByTestId("note-body").fill("ETH attention leads price by about an hour.");
  await page.getByTestId("note-save").click();
  const note = page.getByTestId("note-card").filter({ hasText: title });
  await expect(note).toBeVisible();
  await note.getByTestId("note-raw").click();
  const sealed = note.getByTestId("note-ciphertext");
  await expect(sealed).toBeVisible();
  await expect(sealed).not.toContainText("ETH attention");
  await page.reload();
  await withIdentity(page, page.getByTestId("note-new"));
  await expect(note).toContainText("ETH attention leads price by about an hour.");
  await note.getByTestId("note-edit").click();
  await page.getByTestId("note-body").fill("Edited: attention leads price on the way up only.");
  await page.getByTestId("note-save").click();
  await expect(note).toContainText("Edited: attention leads price on the way up only.");
  await note.getByTestId("note-raw").click();
  await expect(note.getByTestId("note-ciphertext")).toContainText("version 2");
  await note.getByTestId("note-delete").click();
  await note.getByTestId("note-delete").click();
  await expect(note).toHaveCount(0);

  // Notifications: permission is granted in this browser; subscribe, change a topic, turn off.
  await page.goto("/settings#notifications");
  const push = page.getByTestId("push");
  await expect(push).toHaveAttribute("data-on", "false");
  await page.getByTestId("push-on").click();
  await expect(push).toHaveAttribute("data-on", "true", { timeout: 60_000 });
  const markets = page.getByRole("switch", { name: "Markets notifications" });
  await expect(markets).toHaveAttribute("aria-checked", "true");
  // The topic is saved to the backend before the reload checks that it stuck.
  const saved = page.waitForResponse((r) => r.url().endsWith("/v1/push/subscriptions") && r.request().method() === "POST");
  await markets.click();
  await expect(markets).toHaveAttribute("aria-checked", "false");
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(push).toHaveAttribute("data-on", "true");
  await expect(page.getByRole("switch", { name: "Markets notifications" })).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.scriptURL)).toMatch(/\/sw\.js$/);
  await page.getByTestId("push-off").click();
  await expect(push).toHaveAttribute("data-on", "false");
});

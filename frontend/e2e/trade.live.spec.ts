import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { expect, fundWithFaucet, landed, LIVE, passkeyUses, test } from "./live";

/**
 * Trading on the live Testnet stack with the worker's passkey account: test USDC from the faucet,
 * an Up (or Down) buy on the order book and an attention perp, all through the session key with no passkey
 * prompt, then the portfolio holding both. Then the same passkey on a second device finds the
 * account again (its key recovered from one signature) and opens a session there.
 *
 * E2E_TREND picks the trend (default topic:world-cup); it must be live, with a fresh index and a
 * quoted book, or the contracts refuse the trades (the spec then reports their reason).
 */

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");

const TREND = process.env.E2E_TREND ?? "topic:world-cup";

test("test USDC, an Up/Down buy and an attention perp, with no passkey prompt, then the portfolio", async ({ live, account }) => {
  const { page } = live;
  expect(account).toMatch(/^0u[0-9a-z]+$/);
  const prompts = await passkeyUses(live);

  // Test USDC through the session (the faucet allows one draw per cooldown).
  await fundWithFaucet(page);

  // A buy for 2 USDC on the order book, anchored to the attention-implied price: Up, unless the
  // market has run away and Up is all but certain, when no one sells it under 1 USDC; then Down.
  await page.goto(`/t/${TREND}`);
  const panel = page.getByTestId("trade-panel");
  await panel.getByRole("radio", { name: "Up/Down" }).click();
  const quoted = async (side: "up" | "down") => /\d/.test((await panel.getByTestId(`outcome-side-${side}`).innerText()).split("\n")[1] ?? "");
  await expect.poll(async () => (await quoted("up")) || (await quoted("down")), { timeout: 30_000 }).toBe(true);
  if (!(await quoted("up"))) await panel.getByTestId("outcome-side-down").click();
  await panel.getByTestId("outcome-amount").fill("2");
  const buy = panel.getByTestId("outcome-submit");
  await expect(buy).toBeEnabled({ timeout: 30_000 });
  await buy.click();
  await landed(panel.getByTestId("outcome-tx"));

  // A 2x long attention perp with 2 USDC of margin.
  await panel.getByRole("radio", { name: "Perp" }).click();
  await panel.getByTestId("perp-margin").fill("2");
  const open = panel.getByTestId("perp-submit");
  await expect(open).toBeEnabled({ timeout: 30_000 });
  await open.click();
  await landed(panel.getByTestId("perp-tx"));

  // The session signed all of it: no passkey prompt since sign-up.
  expect(await passkeyUses(live)).toBe(prompts);

  // The portfolio holds the Up tokens and the position, read from NEAR.
  await page.goto("/portfolio");
  await expect(page.getByTestId("outcome-row").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("perp-position").first()).toBeVisible({ timeout: 60_000 });
});

test("the same passkey on a second device finds the account and opens a session there", async ({ live, account }) => {
  // The passkey, as a synced passkey would arrive on another device.
  const { credentials } = await live.cdp.send("WebAuthn.getCredentials", { authenticatorId: live.authenticatorId });
  expect(credentials.length).toBeGreaterThan(0);

  const dir = mkdtempSync(join(tmpdir(), "tredio-live-2-"));
  const context = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: true, baseURL: live.origin, viewport: { width: 1280, height: 900 } });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("/");
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
    });
    for (const credential of credentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });

    await page.getByRole("button", { name: "Sign in" }).first().click();
    const sheet = page.getByTestId("account-sheet");
    await expect(sheet).toBeVisible();
    await page.getByTestId("sign-in").click();
    const address = page.getByTestId("account-address");
    await expect(address).toBeVisible({ timeout: 120_000 });
    await expect(address).toHaveAttribute("data-address", account);
    await expect(sheet.getByText("Synced")).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

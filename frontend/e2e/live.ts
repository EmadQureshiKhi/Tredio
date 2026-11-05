import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, type BrowserContext, type CDPSession, chromium, expect, type Locator, type Page } from "@playwright/test";

/**
 * The live Testnet specs share one Chrome profile and one new passkey account per worker: every
 * activation costs the relayer testnet fees, so the account is made once and each spec file builds
 * on it (a failure restarts the worker, which starts over with a new account). The profile is a
 * real one on disk because push needs Chrome's push service, which incognito contexts lack; a CDP
 * virtual authenticator with PRF stands in for the user's passkey.
 */

export const LIVE = Boolean(process.env.TREDIO_LIVE);

export interface Live {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
  origin: string;
}

async function launch(baseURL: string): Promise<Live & { dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tredio-live-"));
  const context = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: true, baseURL, viewport: { width: 1280, height: 900 } });
  const origin = new URL(baseURL).origin;
  await context.grantPermissions(["notifications", "clipboard-read", "clipboard-write"], { origin });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto("/");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  return { context, page, cdp, authenticatorId, origin, dir };
}

/** One passkey prompt: a new Testnet account, activated for free, signed in to the backend. */
async function signUp(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).first().click();
  const sheet = page.getByTestId("account-sheet");
  await expect(sheet).toBeVisible();
  await page.getByTestId("create-account").click();
  const address = page.getByTestId("account-address");
  await expect(address).toBeVisible({ timeout: 90_000 });
  await expect(sheet.getByText("Synced")).toBeVisible({ timeout: 30_000 });
  const value = (await address.getAttribute("data-address")) ?? "";
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  console.log(`live account ${value}`);
  return value;
}

export const test = base.extend<object, { live: Live; account: string }>({
  live: [
    async ({}, use, workerInfo) => {
      const l = await launch(workerInfo.project.use.baseURL ?? "http://localhost:3000");
      await use(l);
      await l.context.close();
      rmSync(l.dir, { recursive: true, force: true });
    },
    { scope: "worker", timeout: 120_000 },
  ],
  account: [async ({ live }, use) => use(await signUp(live.page)), { scope: "worker", timeout: 150_000 }],
});

export { expect };

/** How many times the passkey has signed: each owner prompt is one assertion. */
export async function passkeyUses(live: Live): Promise<number> {
  const { credentials } = await live.cdp.send("WebAuthn.getCredentials", { authenticatorId: live.authenticatorId });
  return credentials.reduce((n, c) => n + c.signCount, 0);
}

/**
 * Waits for a screen that needs the caller key. The device unlocked the key at sign-up, so the
 * screen must never ask for the passkey again after a page load: that would be a regression in
 * the account layer's restore.
 */
export async function withIdentity(page: Page, ready: Locator) {
  const unlock = page.getByRole("button", { name: "Unlock with passkey" }).first();
  await expect(ready.or(unlock)).toBeVisible();
  await expect(unlock, "the caller key read as locked after a page load on a device that holds it").toBeHidden();
  await expect(ready).toBeVisible();
}

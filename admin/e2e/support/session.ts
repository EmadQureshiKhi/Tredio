import { expect, type Page } from "@playwright/test";
import { AdminApi } from "./backend";
import { adminAccount } from "./wallet";

export const SESSION_KEY = "tredio-admin:session";

/**
 * Signs in as the admin account. NEAR wallets run in NEAR Connect's sandboxed popups, which a test
 * cannot drive, so the test process signs the same NEP-413 session request the wallet would, gets
 * the backend's bearer token, and hands it to the page the way the panel stores it.
 */
export async function signInAsAdmin(page: Page, path = "/candidates"): Promise<void> {
  const session = await new AdminApi(adminAccount()).freshSession();
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), { key: SESSION_KEY, value: JSON.stringify(session) });
  await page.goto(path);
  await expect(page.getByTestId("session-account")).toBeVisible();
}

export const storedSession = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);

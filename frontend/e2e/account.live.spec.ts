import { deployment, latestAccountCode } from "@tredio/contracts";
import { expect, LIVE, passkeyUses, test } from "./live";

/**
 * Account code on the live Testnet stack. A new account moves onto the newest published code in its
 * first request, so it reads that version straight away; an account made before it was published (a
 * saved passkey from E2E_PASSKEY_FILE) shows Upgrade in Settings, which takes one passkey prompt.
 * Either way the account ends on the code hash deployments names, read from the chain.
 */
const LATEST = latestAccountCode(deployment("testnet"))!;

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");

test("the account runs the newest account code, upgrading from Settings with one passkey prompt when it is older", async ({ live, account }) => {
  const { page } = live;
  await page.goto("/settings");
  const badge = page.getByText(/^Version \d+$/);
  await expect(badge).toBeVisible();
  const upgrade = page.getByTestId("upgrade-account");
  if (await upgrade.isVisible()) {
    await expect(badge).not.toHaveText(`Version ${LATEST.version}`);
    const prompts = await passkeyUses(live);
    await upgrade.click();
    await expect(badge).toHaveText(`Version ${LATEST.version}`, { timeout: 90_000 });
    expect(await passkeyUses(live), "the upgrade takes exactly one passkey prompt").toBe(prompts + 1);
  } else {
    await expect(badge).toHaveText(`Version ${LATEST.version}`);
  }
  await expect(upgrade).toBeHidden();

  // The chain agrees: the account's global code is the newest published hash.
  const res = await fetch("https://near-testnet.drpc.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: account } }),
  });
  const state = (await res.json()) as { result: { global_contract_hash?: string } };
  expect(state.result.global_contract_hash).toBe(LATEST.hash);
});

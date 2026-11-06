import { expect, fundWithFaucet, landed, LIVE, passkeyUses, test } from "./live";

/**
 * The market flows beyond a first trade, on the live Testnet stack with the worker's passkey
 * account: a limit order that rests on the book and is cancelled, Up/Down pairs minted and
 * redeemed, an attention perp topped up and closed, a trend coin bought and sold, and USDC sent to
 * another NEAR account. Session actions need no prompt; owner actions (limit orders, cancels,
 * margin, coin trades, withdrawals) take exactly one passkey prompt each and go through the relayer,
 * whose answer carries the receipts the app reads (the order id, or a refusal).
 *
 * E2E_TREND picks the trend (default topic:world-cup): live, with a fresh index, a quoted book and a
 * launched coin.
 */

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");

const TREND = process.env.E2E_TREND ?? "topic:world-cup";

test.beforeAll(async ({ live, account }) => {
  // Signing in on a fresh worker and drawing USDC wait on testnet RPC, which a shared address can slow down.
  test.setTimeout(600_000);
  expect(account).toMatch(/^0u[0-9a-z]+$/);
  await fundWithFaucet(live.page);
});

test("a limit order rests on the book, then cancels, one passkey prompt each", async ({ live }) => {
  const { page } = live;
  await page.goto(`/t/${TREND}`);
  const panel = page.getByTestId("trade-panel");
  await panel.getByRole("radio", { name: "Up/Down" }).click();
  await panel.getByRole("radio", { name: "Limit" }).click();
  await panel.getByTestId("outcome-side-up").click();
  // Far below the market, so it rests instead of filling.
  await panel.getByTestId("outcome-limit-price").fill("5.0");
  await panel.getByTestId("outcome-amount").fill("4");
  const before = await passkeyUses(live);
  const place = panel.getByTestId("outcome-limit-submit");
  await expect(place).toBeEnabled({ timeout: 30_000 });
  await place.click();
  await landed(panel.getByTestId("outcome-tx"));
  expect(await passkeyUses(live)).toBe(before + 1);

  const orders = panel.getByTestId("open-orders");
  await expect(orders).toContainText(/Buy 4(\.00)? Up at 5\.0/, { timeout: 60_000 });
  await orders.getByRole("button", { name: "Cancel" }).first().click();
  await landed(panel.getByTestId("book-tx"));
  expect(await passkeyUses(live)).toBe(before + 2);
  await expect(orders.getByText(/Buy 4(\.00)? Up at 5\.0/)).toBeHidden({ timeout: 60_000 });

  // The cancelled order's USDC waits in the book until it is withdrawn (a session action, no prompt).
  const withdraw = panel.getByTestId("book-withdraw");
  if (await withdraw.isVisible()) {
    await withdraw.click();
    await landed(panel.getByTestId("book-tx"));
    expect(await passkeyUses(live)).toBe(before + 2);
  }
});

test("pairs mint for USDC and redeem for it, through the session", async ({ live }) => {
  const { page } = live;
  await page.goto(`/t/${TREND}`);
  const panel = page.getByTestId("trade-panel");
  await panel.getByRole("radio", { name: "Up/Down" }).click();
  const before = await passkeyUses(live);
  await panel.getByRole("button", { name: "Pairs", exact: true }).click();
  await panel.getByTestId("mint-amount").fill("1");
  await panel.getByTestId("mint-pairs").click();
  await landed(panel.getByTestId("pairs-tx"));
  const redeem = panel.getByTestId("redeem-pairs");
  await expect(redeem).toBeVisible({ timeout: 60_000 });
  await redeem.click();
  await landed(panel.getByTestId("pairs-tx"));
  expect(await passkeyUses(live)).toBe(before);
});

test("an attention perp takes more margin with one prompt and closes through the session", async ({ live }) => {
  const { page } = live;
  await page.goto(`/t/${TREND}`);
  const panel = page.getByTestId("trade-panel");
  await panel.getByRole("radio", { name: "Perp" }).click();
  const positions = panel.getByTestId("perp-position");
  // Positions from earlier runs may be open: wait for the new one before acting on it, not just any last card.
  await expect(panel.getByTestId("perp-margin")).toBeVisible({ timeout: 30_000 });
  // The positions list loads from chain after the ticket: count once it holds steady.
  let held = -1;
  await expect(async () => {
    const first = await positions.count();
    await page.waitForTimeout(2_000);
    held = await positions.count();
    expect(held).toBe(first);
  }).toPass({ timeout: 45_000 });
  await panel.getByTestId("perp-margin").fill("2");
  const open = panel.getByTestId("perp-submit");
  await expect(open).toBeEnabled({ timeout: 30_000 });
  await open.click();
  await landed(panel.getByTestId("perp-tx"));

  await expect(positions).toHaveCount(held + 1, { timeout: 60_000 });
  const position = positions.nth(held);
  const before = await passkeyUses(live);
  await position.getByRole("button", { name: "Add margin" }).click();
  await position.getByTestId("perp-add-margin").fill("1");
  await position.getByRole("button", { name: /^Add 1/ }).click();
  await landed(position.getByTestId("perp-position-tx"));
  expect(await passkeyUses(live)).toBe(before + 1);

  await position.getByTestId("perp-close").click();
  await expect(positions).toHaveCount(held, { timeout: 90_000 });
  expect(await passkeyUses(live)).toBe(before + 1);
});

test("a trend coin buys and sells on its curve, one prompt each", async ({ live }) => {
  const { page } = live;
  await page.goto(`/t/${TREND}`);
  const panel = page.getByTestId("trade-panel");
  await panel.getByRole("radio", { name: "Coin" }).click();
  const before = await passkeyUses(live);
  await panel.getByRole("radio", { name: "Buy" }).click();
  await panel.getByTestId("coin-amount").fill("1");
  const submit = panel.getByTestId("coin-submit");
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
  await landed(panel.getByTestId("coin-tx"));
  expect(await passkeyUses(live)).toBe(before + 1);

  await panel.getByRole("radio", { name: "Sell" }).click();
  await panel.getByRole("button", { name: /Max/ }).click();
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
  await landed(panel.getByTestId("coin-tx"));
  expect(await passkeyUses(live)).toBe(before + 2);
});

test("USDC goes to another NEAR account with one prompt", async ({ live }) => {
  const { page } = live;
  await page.goto("/settings");
  await page.getByTestId("withdraw-to").fill("tredio-treasury.testnet");
  await page.getByTestId("withdraw-amount").fill("0.5");
  const before = await passkeyUses(live);
  const send = page.getByTestId("withdraw-submit");
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();
  await landed(page.getByTestId("withdraw-tx"));
  expect(await passkeyUses(live)).toBe(before + 1);
});

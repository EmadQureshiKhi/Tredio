import { expect, test, type Page } from "@playwright/test";
import { AdminApi, BACKEND_URL } from "./support/backend";
import { signInAsAdmin } from "./support/session";
import { adminAccount } from "./support/wallet";

const api = new AdminApi(adminAccount());

const card = (page: Page, title: string) => page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("shows backend health as /v1/admin/health reports it", async ({ page }) => {
  const h = await api.health();
  const detail = page.waitForResponse((r) => r.url().endsWith("/v1/admin/health"));
  const trends = ((await (await fetch(`${BACKEND_URL}/v1/trends`)).json()) as { trends: unknown[] }).trends;
  await signInAsAdmin(page, "/operations");
  expect((await detail).request().headers().authorization).toMatch(/^Bearer \S+/);

  await expect(page.getByTestId("health-banner")).toBeVisible();
  await expect(card(page, "Database")).toContainText(h.db === "ok" ? "Connected" : "Down");

  if (typeof h.oracle === "object") {
    const oracle = card(page, "Oracle");
    await expect(oracle).toContainText(/\d+ of \d+/);
    await expect(oracle).toContainText(h.oracle.lastRunId > 0 ? /ago|just now/ : /never/);
  }

  const budgets = card(page, "Data budgets");
  for (const [name, budget] of [["Elfa", h.budgets.elfa], ["Nansen", h.budgets.nansen]] as const) {
    const row = budgets.locator("dl > div").filter({ hasText: name });
    await expect(row).toContainText(budget ? `${budget.keys} ${budget.keys === 1 ? "key" : "keys"}` : "not configured");
  }
  if (h.budgets.ai !== undefined) await expect(budgets.locator("dl > div").filter({ hasText: "AI calls" })).toContainText(h.budgets.ai ? "left today" : "unlimited");

  const ai = card(page, "AI providers").getByRole("listitem");
  await expect(ai).toHaveCount(h.ai.length);
  for (const [i, name] of h.ai.entries()) await expect(ai.nth(i)).toContainText(name);

  await expect(card(page, "GDELT")).toContainText(/Available|Resting/);

  for (const job of ["radar", "collector", "history"]) {
    const section = page.locator(`[data-job="${job}"]`);
    await expect(section.getByText("Last success")).toBeVisible();
    await expect(section.getByRole("button", { name: `Run ${job} now` })).toBeEnabled();
  }

  await expect(page.getByTestId("live-trend")).toHaveCount(trends.length);
});

test("runs the collector on demand and waits for it to finish", async ({ page }) => {
  // A run measures whatever is due, so on the real backend it takes seconds to a few minutes.
  test.setTimeout(240_000);
  await signInAsAdmin(page, "/operations");
  const collector = page.locator('[data-job="collector"]');
  const started = page.waitForResponse((r) => r.url().endsWith("/v1/admin/jobs/collector/run"));
  await collector.getByRole("button", { name: "Run collector now" }).click();
  const res = await started;
  expect(res.status()).toBe(202);
  const { started: freshRun } = (await res.json()) as { started: boolean };
  const status = collector.getByTestId("run-status");
  await expect(status).toHaveText(freshRun ? /^Running/ : /^Already running/);
  await expect(status).toHaveText(/^Finished/, { timeout: 200_000 });
  await expect(page.getByRole("status").filter({ hasText: "Collector run finished" })).toBeVisible();
  await expect(collector.getByRole("button", { name: "Run collector now" })).toBeEnabled();
});

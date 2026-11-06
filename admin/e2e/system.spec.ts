import { expect, test, type Page } from "@playwright/test";
import type { SystemReport } from "../src/types/admin";
import { AdminApi } from "./support/backend";
import { signInAsAdmin } from "./support/session";
import { adminAccount } from "./support/wallet";

const api = new AdminApi(adminAccount());

/** Text no part of the page may ever show: Elfa keys, credentials in URLs, provider API keys. */
const SECRET_PATTERNS = [/elfak_/i, /\/\/[^\s/@]+:[^\s/@]+@/, /AIza[A-Za-z0-9_-]{10,}/];

const section = (page: Page, id: string) => page.locator(`section#${id}`);

test("shows the whole system report, worst first, with real data in every section", async ({ page }) => {
  const report = page.waitForResponse((r) => r.url().endsWith("/v1/admin/system") && r.request().method() === "GET");
  await signInAsAdmin(page, "/system");
  const res = await report;
  expect(res.request().headers().authorization).toMatch(/^Bearer \S+/);
  const r = (await res.json()) as SystemReport;
  // The same report the admin API gives the test process (the backend caches it for a few seconds).
  expect((await api.system()).services.map((s) => s.name)).toEqual(r.services.map((s) => s.name));

  // The top: the overall state and every problem, most severe first.
  const overall = page.getByTestId("overall");
  await expect(overall).toHaveAttribute("data-status", r.status);
  await expect(overall).toContainText(r.status === "ok" ? "All systems normal" : r.status === "degraded" ? "Degraded" : "Critical");
  const problems = page.getByTestId("problem");
  await expect(problems).toHaveCount(r.problems.length);
  for (const [i, p] of r.problems.entries()) await expect(problems.nth(i)).toContainText(p.title);
  const severities = await problems.evaluateAll((els) => els.map((e) => e.getAttribute("data-severity")));
  const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
  expect(severities.map((s) => rank[s!])).toEqual([...severities.map((s) => rank[s!]!)].sort((a, b) => a - b));
  await expect(page.getByTestId("summary-tile")).toHaveCount(9);
  await expect(page.getByTestId("updated")).toContainText(/Updated (just now|\d+s ago)/);

  // Services: every probed service plus the backend and oracle.
  const rows = page.getByTestId("service-row");
  await expect(rows).toHaveCount(r.services.length);
  for (const s of r.services) await expect(page.locator(`[data-testid="service-row"][data-key="${s.name}"]`)).toContainText(s.state === "up" ? "Up" : s.state === "down" ? "Down" : "Degraded");

  // Oracle.
  await expect(page.getByTestId("oracle-card")).toContainText(/Last report/);

  // Elfa keys: each key by its last four characters and its route host, never the key.
  if (r.elfa.configured) {
    await expect(page.getByTestId("elfa-key")).toHaveCount(r.elfa.keys.length);
    for (const k of r.elfa.keys) {
      const row = page.locator(`[data-testid="elfa-key"][data-key="${k.index}"]`);
      await expect(row).toContainText(k.key);
      await expect(row).toContainText(k.route);
    }
  }

  // Sources, AI, jobs and errors.
  await expect(page.getByTestId("source-row")).toHaveCount(r.sources.length);
  await expect(page.getByTestId("ai-provider")).toHaveCount(r.ai.providers.length);
  await expect(page.getByTestId("job-row")).toHaveCount(r.jobs.length);
  if (r.errors.length > 0) await expect(page.getByTestId("recent-error")).toHaveCount(r.errors.length);

  const text = await page.locator("main, body").first().innerText();
  for (const re of SECRET_PATTERNS) expect(text).not.toMatch(re);
  const body = JSON.stringify(r);
  for (const re of SECRET_PATTERNS) expect(body).not.toMatch(re);
});

test("a stopped service goes to the top as a critical problem", async ({ page }) => {
  // The panel shows what the backend ranks; here the backend's answer says the top-up service stopped.
  await page.route("**/v1/admin/system", async (route) => {
    const res = await route.fetch();
    const r = (await res.json()) as SystemReport;
    const topup = r.services.find((s) => s.name === "topup");
    if (topup) Object.assign(topup, { state: "down", httpStatus: null, latencyMs: null, reason: "no answer (connection refused or unreachable)" });
    r.problems.unshift({ severity: "critical", area: "services", title: "topup is down", detail: "no answer (connection refused or unreachable)" });
    r.status = "critical";
    await route.fulfill({ response: res, json: r });
  });
  await signInAsAdmin(page, "/system");
  await expect(page.getByTestId("overall")).toHaveAttribute("data-status", "critical");
  const first = page.getByTestId("problem").first();
  await expect(first).toHaveAttribute("data-severity", "critical");
  await expect(first).toContainText("topup is down");
  await expect(first).toContainText("Critical");
  // Worst first in the services table too.
  await expect(page.getByTestId("service-row").first()).toHaveAttribute("data-key", "topup");
  await expect(page.getByTestId("service-row").first()).toContainText("Down");
});

test("tables sort by a column, and checking the Elfa keys asks first", async ({ page }) => {
  await signInAsAdmin(page, "/system");
  const table = page.getByTestId("services-table").locator("table");
  const header = table.getByRole("columnheader", { name: /Service/ });
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  const names = await page.getByTestId("service-row").locator("td:first-child p.font-medium").allInnerTexts();
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");

  const check = page.getByRole("button", { name: "Check keys now" });
  if (await check.count()) {
    let posted = false;
    page.on("request", (req) => {
      if (req.url().endsWith("/v1/admin/system/elfa-check")) posted = true;
    });
    await check.click();
    const dialog = page.getByRole("dialog", { name: "Check every Elfa key?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("It costs one credit each");
    // Cancelling spends nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(posted).toBe(false);
  }
});

test("works at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsAdmin(page, "/system");
  await expect(page.getByTestId("overall")).toBeVisible();
  await expect(page.getByTestId("service-card-mobile").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(section(page, "elfa")).toBeVisible();
});

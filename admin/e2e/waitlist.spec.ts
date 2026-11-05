import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { AdminApi, joinWaitlist } from "./support/backend";
import { signInAsAdmin } from "./support/session";
import { adminAccount } from "./support/wallet";

const api = new AdminApi(adminAccount());

/**
 * The Mainnet waitlist page against the real backend. The test joins with its own
 * waitlist-check address, finds it by search, marks it invited, exports the CSV and deletes it
 * through the page, so no other signup is touched and nothing is left behind.
 */
test("finds a signup, marks it invited, exports the list and deletes it", async ({ page }) => {
  const email = `waitlist-check+${Date.now()}-admin@tredio.bid`;
  await joinWaitlist(email);
  try {
    await signInAsAdmin(page, "/waitlist");
    await expect(page.getByRole("heading", { name: "Waitlist", level: 1 })).toBeVisible();
    const before = await api.waitlist("");
    await expect(page.getByTestId("waitlist-total")).toHaveText(before.total.toLocaleString("en-US"));

    // Search narrows the list to the new signup.
    await page.getByRole("searchbox", { name: "Search the waitlist by email or account" }).fill(email);
    const row = page.locator(`[data-testid="waitlist-row"][data-email="${email}"]`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId("waitlist-row")).toHaveCount(1);
    await expect(row).toContainText("Website");
    await expect(row).toContainText("Waiting");
    await expect(page.getByTestId("waitlist-range")).toHaveText("1–1 of 1 match");

    // Mark invited.
    await row.getByRole("checkbox", { name: `Select ${email}` }).check();
    await page.getByRole("button", { name: "Mark invited" }).click();
    await expect(page.getByText("Marked 1 signup invited")).toBeVisible();
    await expect(row).toContainText("Invited");
    expect((await api.waitlist(email)).rows[0]?.invitedAt).not.toBeNull();

    // The CSV holds every signup, this one included.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^tredio-waitlist-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await readFile((await file.path())!, "utf8");
    expect(csv.split("\r\n")[0]).toBe("id,email,source,account,created_at,updated_at,invited_at,unsubscribed_at");
    expect(csv).toContain(`,${email},landing,`);

    // Delete it, after a confirmation that names it.
    await row.getByRole("checkbox", { name: `Select ${email}` }).check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete 1 signup?" });
    await expect(dialog).toContainText(email);
    await dialog.getByRole("button", { name: "Delete for good" }).click();
    await expect(page.getByText("Deleted 1 signup")).toBeVisible();
    await expect(page.getByText("No signups match")).toBeVisible();
    expect((await api.waitlist(email)).matching).toBe(0);
  } finally {
    // A failure part way leaves no test row behind; only this test's row is ever removed.
    const left = (await api.waitlist(email)).rows.filter((r) => r.email === email).map((r) => r.id);
    if (left.length > 0) await api.deleteWaitlist(left);
  }
});

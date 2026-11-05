import { expect, test, type Page } from "@playwright/test";
import { classOf } from "../src/modules/candidates/validation";
import type { Candidate, CandidateStatus } from "../src/types/admin";
import { AdminApi, liveIdentifiers } from "./support/backend";
import { signInAsAdmin } from "./support/session";
import { adminAccount } from "./support/wallet";

/**
 * Review flows against the real backend. Approving a radar candidate would list it as a live trend,
 * so every test works on rejected (or already approved) rows that are not live, keeps any
 * approval to the moment it takes to assert it, and restores status and fields afterwards.
 */

const api = new AdminApi(adminAccount());
const card = (page: Page, id: number) => page.locator(`article[data-candidate-id="${id}"]`);
const isDecision = (url: string) => /\/v1\/admin\/candidates\/\d+\/decision$/.test(url);

/**
 * A rejected candidate that never went live, with a summary (the API cannot put a summary
 * back to null) and a class that matches its identifier (restoring the identifier resets the class).
 */
async function rejectedFixture(opts: { exclude?: number[]; withArticle?: boolean; maxKeywords?: number } = {}): Promise<Candidate> {
  const [rows, live] = await Promise.all([api.candidates("rejected"), liveIdentifiers()]);
  const pick = rows.find(
    (c) =>
      c.summary !== null &&
      classOf(c.identifier) === c.assetClass &&
      !live.has(c.identifier) && !opts.exclude?.includes(c.id) && (!opts.withArticle || c.article !== null) && c.keywords.length <= (opts.maxKeywords ?? 5),
  );
  test.skip(!pick, "needs a rejected candidate that is not live");
  return pick!;
}

async function expectRestored(snapshot: Candidate) {
  const now = await api.candidate(snapshot.id);
  expect({ ...now, updatedAt: "", decidedBy: "" }).toEqual({ ...snapshot, updatedAt: "", decidedBy: "" });
}

test("each status tab lists what the admin API returns", async ({ page }) => {
  await signInAsAdmin(page);
  const tabs: Array<[string, CandidateStatus | null]> = [
    ["Approved", "approved"],
    ["Rejected", "rejected"],
    ["Live", "live"],
    ["All", null],
    ["Pending", "pending"],
  ];
  for (const [label, status] of tabs) {
    const expected = await api.candidates(status);
    await page.getByRole("tab", { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByRole("tab", { name: new RegExp(`^${label}`) })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(status === "pending" ? /\/candidates$/ : new RegExp(`\\?status=${status ?? "all"}$`));
    const panel = page.getByRole("tabpanel");
    if (expected.length === 0) {
      await expect(panel.getByRole("heading", { level: 2 })).toBeVisible();
      continue;
    }
    await expect(panel.locator("article[data-candidate-id]")).toHaveCount(expected.length);
    const first = card(page, expected[0]!.id);
    await expect(first.getByRole("heading", { level: 3 })).toHaveText(expected[0]!.displayName);
    await expect(first.getByTestId("candidate-identifier")).toHaveText(expected[0]!.identifier);
  }

  // The tab survives a reload.
  await page.getByRole("tab", { name: /^Rejected/ }).click();
  await page.reload();
  await expect(page.getByRole("tab", { name: /^Rejected/ })).toHaveAttribute("aria-selected", "true");
});

test("the review form checks fields the way the backend does and sends nothing invalid", async ({ page }) => {
  const c = await rejectedFixture({ maxKeywords: 3 });
  const decisions: string[] = [];
  page.on("request", (r) => {
    if (isDecision(r.url())) decisions.push(r.url());
  });
  await signInAsAdmin(page, "/candidates?status=rejected");
  await card(page, c.id).getByRole("button", { name: "Review" }).click();
  const dialog = page.getByRole("dialog", { name: `Review ${c.displayName}` });
  await expect(dialog).toBeVisible();

  const identifier = dialog.getByLabel("Identifier", { exact: true });
  await expect(identifier).toHaveValue(c.identifier);
  await identifier.fill("Topic:Shouting");
  await expect(dialog.getByText("Use lowercase a-z, 0-9 and : . _ - only.")).toBeVisible();
  await expect(identifier).toHaveAttribute("aria-invalid", "true");
  await identifier.fill("topic:returning-trend.2");
  await expect(dialog.getByText(/Drop the version suffix/)).toBeVisible();
  await identifier.fill(`topic:${"a".repeat(59)}`);
  await expect(dialog.getByText("Use at most 64 characters (now 65).")).toBeVisible();
  // A missing class prefix is legal for the backend, so it only warns.
  await identifier.fill("no-class-prefix");
  await expect(dialog.getByText(/Write it as <class>:<slug>/)).toBeVisible();
  await expect(identifier).not.toHaveAttribute("aria-invalid", "true");
  await identifier.fill(c.identifier);

  const name = dialog.getByLabel("Display name", { exact: true });
  await name.fill("x".repeat(41));
  await expect(dialog.getByText("Use at most 40 characters (now 41).")).toBeVisible();
  await name.fill("   ");
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog.getByText("Enter a display name.")).toBeVisible();
  await expect(name).toBeFocused();
  await name.fill(c.displayName);

  // Enter in a keyword adds a row; at most five; empty, long and repeated keywords are refused.
  const keywords = dialog.getByRole("textbox", { name: /^Keyword \d$/ });
  await keywords.last().press("Enter");
  await expect(keywords).toHaveCount(c.keywords.length + 1);
  await expect(keywords.last()).toBeFocused();
  const add = dialog.getByRole("button", { name: "Add keyword" });
  while (await add.isEnabled()) await add.click();
  await expect(keywords).toHaveCount(5);
  await dialog.getByRole("button", { name: "Reject" }).click();
  await expect(dialog.getByText("Enter a keyword or remove this row.").first()).toBeVisible();
  await keywords.nth(c.keywords.length).fill("y".repeat(61));
  await expect(dialog.getByText("Use at most 60 characters (now 61).")).toBeVisible();
  await keywords.nth(c.keywords.length).fill(c.keywords[0]!.toUpperCase());
  await expect(dialog.getByText("This keyword is already listed.")).toBeVisible();

  await dialog.getByLabel("Summary", { exact: true }).fill("z".repeat(141));
  await expect(dialog.getByText("Use at most 140 characters (now 141).")).toBeVisible();

  // A pasted Wikipedia URL becomes the article title.
  const article = dialog.getByLabel("Wikipedia article", { exact: true });
  await article.fill("https://en.wikipedia.org/wiki/Bella_Ramsey");
  await article.blur();
  await expect(article).toHaveValue("Bella_Ramsey");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(decisions).toEqual([]);
  await expectRestored(c);
});

test("approving with edits sends only the changed fields and takes the candidate out of the list", async ({ page }) => {
  const c = await rejectedFixture();
  const edited = {
    identifier: `topic:e2e-review-${Date.now().toString(36)}`,
    displayName: "E2E approval check",
    keywords: [...c.keywords.slice(0, 4), "e2e approval check"],
  };
  await signInAsAdmin(page, "/candidates?status=rejected");
  await card(page, c.id).getByRole("button", { name: "Review" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Identifier", { exact: true }).fill(edited.identifier);
  await dialog.getByLabel("Display name", { exact: true }).fill(edited.displayName);
  const keywords = dialog.getByRole("textbox", { name: /^Keyword \d$/ });
  if (c.keywords.length >= 5) await keywords.nth(4).fill(edited.keywords[4]!);
  else {
    await dialog.getByRole("button", { name: "Add keyword" }).click();
    await keywords.last().fill(edited.keywords.at(-1)!);
  }

  const request = page.waitForRequest((r) => isDecision(r.url()));
  const response = page.waitForResponse((r) => isDecision(r.url()));
  await dialog.getByRole("button", { name: "Approve" }).click();
  try {
    expect((await request).postDataJSON()).toEqual({ decision: "approve", ...edited });
    const res = await response;
    expect(res.status()).toBe(200);
    // The class follows the edited identifier's prefix.
    expect(((await res.json()) as { candidate: Candidate }).candidate).toMatchObject({ id: c.id, status: "approved", assetClass: "topic", ...edited });
    await expect(page.getByRole("status").filter({ hasText: `Approved ${edited.displayName}` })).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(card(page, c.id)).toHaveCount(0);
  } finally {
    await api.restore(c);
  }
  await expectRestored(c);
});

test("rejecting with edits saves them: a new class prefix moves the class, and clearing the article sends null", async ({ page }) => {
  const c = await rejectedFixture({ withArticle: true });
  const newName = `${c.displayName.slice(0, 33)} (e2e)`;
  const newClass = c.assetClass === "topic" ? "person" : "topic";
  const newIdentifier = `${newClass}:e2e-reject-${Date.now().toString(36)}`;
  await signInAsAdmin(page, "/candidates?status=rejected");
  await card(page, c.id).getByRole("button", { name: "Review" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Identifier", { exact: true }).fill(newIdentifier);
  await expect(dialog.getByText(`Saving moves the class from ${c.assetClass} to ${newClass}.`)).toBeVisible();
  await dialog.getByLabel("Display name", { exact: true }).fill(newName);
  await dialog.getByLabel("Wikipedia article", { exact: true }).fill("");

  const request = page.waitForRequest((r) => isDecision(r.url()));
  await dialog.getByRole("button", { name: "Reject" }).click();
  try {
    expect((await request).postDataJSON()).toEqual({ decision: "reject", identifier: newIdentifier, displayName: newName, article: null });
    await expect(page.getByRole("status").filter({ hasText: `Rejected ${newName}` })).toBeVisible();
    // Still rejected, so it stays in the list: first, renamed, and in its new class.
    const edited = card(page, c.id);
    await expect(edited.getByRole("heading", { level: 3 })).toHaveText(newName);
    await expect(edited.getByTestId("candidate-identifier")).toHaveText(newIdentifier);
    await expect(edited.getByTestId("candidate-class")).toHaveText(newClass);
    await expect(page.locator("article[data-candidate-id]").first()).toHaveAttribute("data-candidate-id", String(c.id));
    const saved = await api.candidate(c.id);
    expect(saved).toMatchObject({ status: "rejected", identifier: newIdentifier, assetClass: newClass, displayName: newName, article: null });
  } finally {
    await api.restore(c);
  }
  await expectRestored(c);
});

test("an identifier another candidate uses is refused inline and nothing changes", async ({ page }) => {
  const c = await rejectedFixture();
  const taken = (await api.candidates(null)).find((o) => o.id !== c.id)!;
  await signInAsAdmin(page, "/candidates?status=rejected");
  await card(page, c.id).getByRole("button", { name: "Review" }).click();
  const dialog = page.getByRole("dialog");
  const identifier = dialog.getByLabel("Identifier", { exact: true });
  await identifier.fill(taken.identifier);

  const response = page.waitForResponse((r) => isDecision(r.url()));
  await dialog.getByRole("button", { name: "Reject" }).click();
  expect((await response).status()).toBe(409);
  await expect(dialog.getByText("Another candidate already uses this identifier.")).toBeVisible();
  await expect(identifier).toBeFocused();
  await expect(identifier).toHaveAttribute("aria-invalid", "true");
  // Editing the identifier clears the conflict.
  await identifier.fill(`${taken.identifier}-x`.slice(0, 64));
  await expect(dialog.getByText("Another candidate already uses this identifier.")).toBeHidden();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expectRestored(c);
});

test("a quick reject from the approved list takes effect at once", async ({ page }) => {
  const live = await liveIdentifiers();
  const c = (await api.candidates("approved")).find((a) => !live.has(a.identifier));
  test.skip(!c, "needs an approved candidate that is not live yet");
  await signInAsAdmin(page, "/candidates?status=approved");
  const response = page.waitForResponse((r) => isDecision(r.url()));
  await card(page, c!.id).getByRole("button", { name: "Reject" }).click();
  try {
    expect((await response).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: `Rejected ${c!.displayName}` })).toBeVisible();
    await expect(card(page, c!.id)).toHaveCount(0);
  } finally {
    await api.restore(c!);
  }
  await expectRestored(c!);
});

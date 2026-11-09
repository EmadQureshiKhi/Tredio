import { expect, test, type Page } from "@playwright/test";
import { AdminApi, liveTrends, publicCaller, publicCallStatus, TestCaller, threadOf } from "./support/backend";
import { signInAsAdmin } from "./support/session";
import { adminAccount } from "./support/wallet";

const api = new AdminApi(adminAccount());

/**
 * Social moderation against the real backend. The test makes its own caller identity, gives it a
 * handle, and posts and calls on a live trend as the app would, then hides and restores both
 * through the page and checks the public views follow. It edits only that caller's profile, and
 * leaves its content hidden at the end, so nothing the test wrote stays public.
 */

const row = (page: Page, kind: "posts" | "calls" | "signals", id: number) => page.locator(`[data-testid="moderation-row"][data-kind="${kind}"][data-id="${id}"]`);

async function moderate(page: Page, kind: "posts" | "calls" | "signals", id: number, action: "Hide" | "Restore", reason: string) {
  const noun = kind === "posts" ? "post" : kind === "calls" ? "call" : "signal";
  await row(page, kind, id).getByRole("button", { name: action }).click();
  const dialog = page.getByRole("dialog", { name: `${action} ${noun} #${id}?` });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: `${action} ${noun}` });
  // A reason is required: the log keeps it with the admin's account.
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason").fill(reason);
  await confirm.click();
  await expect(page.getByText(`${action === "Hide" ? "Hid" : "Restored"} ${noun} #${id}`)).toBeVisible();
  await expect(dialog).toBeHidden();
}

test("hides and restores a post and a call, edits a caller and logs every action", async ({ page }) => {
  const trend = (await liveTrends())[0];
  test.skip(!trend, "needs a live trend to post and call on");
  const caller = new TestCaller();
  const handle = `e2e_mod_${Date.now().toString(36)}`;
  await caller.profile(handle, "Moderation check from the admin end-to-end tests.");
  const postId = await caller.post(trend!.identifier, `Moderation check ${handle}: this post is hidden and restored by the admin tests.`);
  const callId = await caller.call(trend!.identifier, "up", `Moderation check ${handle}`);
  try {
    await signInAsAdmin(page, "/moderation");
    await expect(page.getByRole("heading", { name: "Moderation", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Moderation" }).first()).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tab", { name: "Posts" })).toHaveAttribute("aria-selected", "true");

    // The newest posts come first, so the new one is on the first page; a caller filter narrows to it.
    await expect(row(page, "posts", postId)).toBeVisible();
    await page.getByRole("searchbox", { name: "Filter by caller handle or identity" }).fill(`@${handle}`);
    await expect(page.getByTestId("moderation-row")).toHaveCount(1);
    await expect(page.getByTestId("moderation-range")).toHaveText("1–1 of 1 match");
    const post = row(page, "posts", postId);
    await expect(post).toContainText(`@${handle}`);
    await expect(post).toContainText(trend!.identifier);
    await expect(post).toHaveAttribute("data-hidden", "false");

    // Hiding takes it out of the trend's public thread; the row stays here, marked, with the reason.
    await moderate(page, "posts", postId, "Hide", "e2e check: hide a post");
    await expect(post).toHaveAttribute("data-hidden", "true");
    await expect(post.getByTestId("moderation-last")).toContainText("e2e check: hide a post");
    expect((await threadOf(trend!.identifier)).posts.map((p) => Number(p.id))).not.toContain(postId);
    await page.getByRole("combobox", { name: "Show" }).selectOption("visible");
    await expect(page.getByText("No posts match")).toBeVisible();
    await page.getByRole("combobox", { name: "Show" }).selectOption("hidden");
    await expect(post).toBeVisible();

    // Restoring brings it back as it was.
    await moderate(page, "posts", postId, "Restore", "e2e check: restore a post");
    await expect(page.getByText("No posts match")).toBeVisible();
    expect((await threadOf(trend!.identifier)).posts.map((p) => Number(p.id))).toContain(postId);
    await page.getByRole("combobox", { name: "Show" }).selectOption("all");

    // The call: hidden, its share lookup answers 404; restored, it is found again.
    await page.getByRole("tab", { name: "Calls" }).click();
    await expect(page).toHaveURL(/\/moderation\?tab=calls$/);
    const call = row(page, "calls", callId);
    await expect(call).toContainText("Up");
    await expect(call).toContainText("Open");
    await moderate(page, "calls", callId, "Hide", "e2e check: hide a call");
    await expect(call).toHaveAttribute("data-hidden", "true");
    expect(await publicCallStatus(callId)).toBe(404);
    expect((await threadOf(trend!.identifier)).calls.map((c) => Number(c.id))).not.toContain(callId);
    await moderate(page, "calls", callId, "Restore", "e2e check: restore a call");
    await expect(call).toHaveAttribute("data-hidden", "false");
    expect(await publicCallStatus(callId)).toBe(200);

    // The caller: found by search, with what they published; editing the profile changes it publicly.
    await page.getByRole("tab", { name: "Callers" }).click();
    await page.getByRole("searchbox", { name: "Search callers by handle, identity or linked account" }).fill(handle);
    const callerRow = page.locator(`[data-testid="caller-row"][data-key="${caller.address}"]`);
    await expect(callerRow).toBeVisible();
    await expect(page.getByTestId("caller-row")).toHaveCount(1);
    await callerRow.getByRole("button", { name: `Edit @${handle}` }).click();
    const edit = page.getByRole("dialog", { name: `Edit @${handle}` });
    await expect(edit).toContainText(caller.address);
    const renamed = `${handle}_x`.slice(0, 20);
    await edit.getByLabel("Handle").fill("Bad Handle!");
    await expect(edit.getByText("3 to 20 of a-z, 0-9 and _.")).toBeVisible();
    await edit.getByLabel("Handle").fill(renamed);
    await edit.getByLabel("Reason").fill("e2e check: edit a profile");
    await edit.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText(`Saved @${renamed}`)).toBeVisible();
    expect(await publicCaller(caller.address)).toMatchObject({ handle: renamed });

    // "Content" filters the posts to this caller.
    await page.getByRole("searchbox", { name: "Search callers by handle, identity or linked account" }).fill(renamed);
    await callerRow.getByRole("button", { name: `Show content by @${renamed}` }).click();
    await expect(page.getByRole("tab", { name: "Posts" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("searchbox", { name: "Filter by caller handle or identity" })).toHaveValue(`@${renamed}`);
    await expect(row(page, "posts", postId)).toBeVisible();
    await expect(page.getByTestId("moderation-row")).toHaveCount(1);

    // The log: every action, newest first, with its reason.
    await page.getByRole("tab", { name: "Log" }).click();
    const log = page.getByTestId("log-row");
    await expect(log.first()).toHaveAttribute("data-action", "rename_caller");
    await expect(log.first()).toContainText("e2e check: edit a profile");
    await expect(log.first()).toContainText(`Was @${handle}`);
    for (const [action, target, reason] of [
      ["restore_call", `calls:${callId}`, "e2e check: restore a call"],
      ["hide_call", `calls:${callId}`, "e2e check: hide a call"],
      ["restore_post", `posts:${postId}`, "e2e check: restore a post"],
      ["hide_post", `posts:${postId}`, "e2e check: hide a post"],
    ]) {
      await expect(page.locator(`[data-testid="log-row"][data-action="${action}"][data-target="${target}"]`)).toContainText(reason);
    }
  } finally {
    // Nothing the test wrote stays public: its post and call end hidden.
    for (const [kind, id] of [["posts", postId], ["calls", callId]] as const) {
      const rows = await api.content(kind, caller.address);
      if (rows.rows.some((r) => r.id === id && r.hiddenAt === null)) await api.moderate(kind, id, "hide", "e2e check: test content");
    }
  }
});

test("lists paid signals in the clear, and hides and restores one", async ({ page }) => {
  const newest = (await api.content("signals", "")).rows[0] as { id: number; hiddenAt: string | null; identifier: string } | undefined;
  test.skip(!newest || newest.hiddenAt !== null, "needs a visible paid signal (scripts/signals-demo.ts publishes one)");
  try {
    await signInAsAdmin(page, "/moderation?tab=signals");
    await expect(page.getByRole("tab", { name: "Signals" })).toHaveAttribute("aria-selected", "true");
    const signal = row(page, "signals", newest!.id);
    // The API holds the signals secret, so the admin reads the signal itself, sealed or not.
    await expect(signal).toContainText(newest!.identifier);
    await expect(signal).toContainText(/(Open|Close) (long|short)/);
    await moderate(page, "signals", newest!.id, "Hide", "e2e check: hide a signal");
    await expect(signal).toHaveAttribute("data-hidden", "true");
    await moderate(page, "signals", newest!.id, "Restore", "e2e check: restore a signal");
    await expect(signal).toHaveAttribute("data-hidden", "false");
    await page.getByRole("tab", { name: "Log" }).click();
    // The log is newest first, and earlier runs left their own rows for this signal.
    await expect(page.locator(`[data-testid="log-row"][data-action="restore_signal"][data-target="signals:${newest!.id}"]`).first()).toContainText(`signal #${newest!.id}`);
  } finally {
    // The signal ends as the test found it: visible.
    const now = (await api.content("signals", "")).rows.find((r) => r.id === newest!.id);
    if (now?.hiddenAt) await api.moderate("signals", newest!.id, "restore", "e2e check: put back");
  }
});

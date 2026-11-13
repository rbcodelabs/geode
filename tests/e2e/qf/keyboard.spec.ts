import { expect, test } from "@playwright/test";
import {
  HAND, attachArtifact, badges, clickAt, commentsToggle, diag, guestKey, launch, openArtifact, pickToggle, popover, rail, rows, sends, si, waitComments, writeDesignArtifact, readComments, statuses, BUY,
} from "./lib";

test.skip(!process.env.QF_PLUGIN, "needs QF_PLUGIN: a built Design plugin directory");

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) info.annotations.push({ type: "diag", description: await diag() });
});

test("QF-K01 keyboard only with the real plugin: pin -> navigate pins -> rail -> send -> focus restoration", async () => {
  test.setTimeout(240_000);
  const s = await launch();
  try {
    const w = s.window;
    const root = writeDesignArtifact(s.vault, "hand", HAND);
    await attachArtifact(w, root, HAND);
    await openArtifact(w, root);
    await expect(commentsToggle(w)).toBeVisible({ timeout: 20_000 });
    await pickToggle(w).focus();
    await w.keyboard.press("Enter");
    await guestKey(s.app, "]");
    await guestKey(s.app, "Enter");
    await expect(popover(w)).toBeVisible({ timeout: 15_000 });
    await expect(popover(w).getByRole("button", { name: "Pin", exact: true })).toBeVisible();
    await w.keyboard.type("Tighten the header.");
    await w.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect(w.locator(".pick-popover-status")).toHaveText("Pinned as comment 1.", { timeout: 20_000 });
    await waitComments(root, (f) => f.comments.length === 1);
    expect((await sends(w)).length).toBe(0);
    await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
    await expect(popover(w).getByRole("button", { name: "Done" })).toBeFocused();
    await w.keyboard.press("Enter");
    await expect(popover(w)).toBeHidden();
    await expect(badges(w).first()).toBeFocused();
    // second pin: pointer to pick, keyboard to finish
    await pickToggle(w).click();
    await clickAt(s.app, BUY.x, BUY.y);
    await expect(popover(w)).toBeVisible();
    await w.keyboard.type("Make Buy larger.");
    await popover(w).getByRole("button", { name: "Pin", exact: true }).focus();
    await w.keyboard.press("Enter");
    await expect(w.locator(".pick-popover-status")).toHaveText("Pinned as comment 2.", { timeout: 20_000 });
    await expect(badges(w)).toHaveCount(2, { timeout: 20_000 });
    await popover(w).getByRole("button", { name: "Done" }).focus();
    await w.keyboard.press("Enter");
    await expect(badges(w).filter({ hasText: "2" })).toBeFocused();
    await w.keyboard.press("ArrowLeft");
    await expect(badges(w).filter({ hasText: "1" })).toBeFocused();
    await w.keyboard.press("End");
    await expect(badges(w).filter({ hasText: "2" })).toBeFocused();
    await w.keyboard.press("Enter");
    await expect(rail(w)).toBeVisible();
    await expect(commentsToggle(w)).toHaveAttribute("aria-expanded", "true");
    await rail(w).locator(".comments-rail-send").focus();
    await expect(rail(w).locator(".comments-rail-send")).toHaveText("Send 2");
    await w.keyboard.press("Enter");
    await waitComments(root, (f) => statuses(f).join() === "sent,sent", 20_000);
    await expect(rail(w).locator(".comments-rail-results")).toHaveText("2 sent");
    expect((await sends(w)).length).toBe(1);
    await rows(w).first().focus();
    await w.keyboard.press("Escape");
    await expect(rail(w)).toBeHidden();
    await expect(commentsToggle(w)).toBeFocused();
  } finally { await s.cleanup(); }
});

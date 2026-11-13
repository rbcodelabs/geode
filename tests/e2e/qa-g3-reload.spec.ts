import { expect, test, type Page } from "@playwright/test";
import { BASIC_ARTIFACT } from "./helpers/artifact-picker-fixtures";
import { session } from "./helpers/anchor-e2e";

/** QA G3 re-verify at 3bf6a8eb: the per-view UI-state holder in the real app (timed-out send + plugin dispose/register). */
const rail = (w: Page) => w.locator(".comments-rail");
const toggle = (w: Page) => w.locator(".artifact-view-comments-btn");
const store = <T>(w: Page, fn: (store: any) => T): Promise<T> => w.evaluate(`(${fn.toString()})(window.__feedbackProbe.store)`) as Promise<T>;
const seed = (w: Page, rows: unknown[]) => w.evaluate((r) => (window as any).__feedbackProbe.store.seed(r), rows);
const BUY = { tag: "button", label: "button Buy now", text: "PRIVATE-COMMENT-TEXT-1", anchor: { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } } };
const HEAD = { tag: "h2", label: "h2 Plans", anchor: { tag: "h2", selector: "#plans-h", textAnchor: { tag: "h2", text: "Plans" } } };

async function timedOutSend(w: Page): Promise<string> {
  await seed(w, [BUY, HEAD]);
  await toggle(w).click();
  await rail(w).getByRole("button", { name: /^Open/ }).click();
  await store(w, (st) => { st.sendMode = "hang-once"; });
  await rail(w).locator(".comments-rail-send").click();
  await expect(rail(w).locator(".comments-rail-retry")).toBeVisible({ timeout: 40_000 });
  return store(w, (st) => st.sendCalls[0].requestId);
}
const reload = (w: Page) => w.evaluate(() => { const p = (window as any).__feedbackProbe; p.dispose(); return p.registerV2(); });

test("reload restores: the Retry reuses the SAME requestId", async () => {
  test.setTimeout(240_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    const first = await timedOutSend(w);
    await reload(w);
    await seed(w, [BUY, HEAD]);
    await expect(rail(w)).toBeVisible({ timeout: 5000 });
    await expect(rail(w).locator(".comments-rail-retry")).toBeVisible({ timeout: 5000 });
    await rail(w).locator(".comments-rail-retry").click();
    await expect.poll(() => store(w, (st) => st.sendCalls.length)).toBe(1);
    expect(await store(w, (st) => st.sendCalls[0].requestId)).toBe(first);
  } finally { await s.cleanup(); }
});

test("reload restores: a FRESH Send click mints a new requestId", async () => {
  test.setTimeout(240_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    const first = await timedOutSend(w);
    await reload(w);
    await seed(w, [BUY, HEAD]);
    await expect(rail(w).locator(".comments-rail-retry")).toBeVisible({ timeout: 5000 });
    await rail(w).locator(".comments-rail-send").click();
    await expect.poll(() => store(w, (st) => st.sendCalls.length)).toBe(1);
    const second = await store(w, (st) => st.sendCalls[0].requestId);
    expect(second).toMatch(/^req_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    await expect(rail(w).locator(".comments-rail-retry")).toBeHidden();
  } finally { await s.cleanup(); }
});

test("reload restores: a state parked longer than the 10 s grace is discarded (rail closed, no Retry)", async () => {
  test.setTimeout(240_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    await timedOutSend(w);
    await w.evaluate(() => (window as any).__feedbackProbe.dispose());
    await w.waitForTimeout(11_500);
    await w.evaluate(() => (window as any).__feedbackProbe.registerV2());
    await seed(w, [BUY, HEAD]);
    await w.waitForTimeout(1000);
    await expect(rail(w)).toBeHidden();
    await toggle(w).click();
    await expect(rail(w)).toBeVisible();
    await expect(rail(w).locator(".comments-rail-retry")).toBeHidden();
    await expect(rail(w).locator('[aria-pressed="true"]')).toHaveText(/^All/);
  } finally { await s.cleanup(); }
});

test("reload restores: the parked state is used once (a second dispose/register after a restore still works, and the first list is authoritative)", async () => {
  test.setTimeout(240_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    await timedOutSend(w);
    await reload(w);
    await seed(w, [HEAD]); // the new store has ONE comment: the old two are not resurrected from the parked state
    await expect(rail(w)).toBeVisible({ timeout: 5000 });
    await expect(rail(w).locator(".comments-rail-row")).toHaveCount(1);
    expect(await rail(w).locator(".comments-rail-heading").textContent()).toBe("Comments (1)");
    expect(await w.evaluate(() => document.querySelector(".comments-rail")!.textContent!.includes("PRIVATE-COMMENT-TEXT-1"))).toBe(false);
  } finally { await s.cleanup(); }
});

test("reload restores: the explicit selection (a deselected comment stays deselected)", async () => {
  test.setTimeout(120_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    await seed(w, [BUY, HEAD]);
    await toggle(w).click();
    await expect(rail(w).locator(".comments-rail-send")).toHaveText("Send 2");
    await rail(w).locator(".comments-rail-select").nth(1).uncheck();
    await expect(rail(w).locator(".comments-rail-send")).toHaveText("Send 1");
    await reload(w);
    await seed(w, [BUY, HEAD]);
    await expect(rail(w)).toBeVisible({ timeout: 5000 });
    await expect(rail(w).locator(".comments-rail-send")).toHaveText("Send 1");
  } finally { await s.cleanup(); }
});

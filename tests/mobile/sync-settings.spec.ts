import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;

async function openSyncTab(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => {
    const app = (window as any).app;
    // Mobile cannot run shared-vault (append-only) providers, so it only ever sees conditional-write ones like this.
    app.sync.register("mobile-probe", { id: "probe.remote", name: "Probe Remote",
      capabilities: { binary: true, conditionalWrites: true, delta: true, completeSnapshots: true, atomicMoves: true, trash: true },
      open: async () => ({
        scan: async () => ({ status: "complete", mode: "snapshot", cursor: "first", entries: [{ id: "r1", path: "Remote.md", kind: "file", revision: "1", size: 6 }] }),
        read: async () => new TextEncoder().encode("remote").buffer,
        create: async ({ path, data, operationKey }: any) => ({ id: "new:" + path, path, kind: "file", revision: "1", size: data.byteLength, operationKey }),
        update: async ({ id, path, data, operationKey }: any) => ({ id, path, kind: "file", revision: "2", size: data.byteLength, operationKey }),
        move: async () => {}, trash: async () => {}, close: async () => {},
      }),
    });
    app.setting.openTabById("sync");
  });
  const modal = page.locator(".modal.mod-settings");
  await expect(modal.getByRole("heading", { name: "Sync", exact: true })).toBeVisible();
  return { modal, content: modal.locator(".vertical-tab-content-container"), errors };
}

/** Everything a thumb has to hit inside the Sync tab must be a real tap target, and nothing may force sideways scrolling. */
async function expectUsableLayout(page: Page, content: ReturnType<Page["locator"]>) {
  const overflow = await content.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(overflow.scroll, "no horizontal scrolling in the Sync tab").toBeLessThanOrEqual(overflow.client + 1);
  const small = await content.evaluate((root) => {
    const bad: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("button, select, input:not([type=checkbox]):not([type=radio])")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height < 43.5) bad.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}" is ${Math.round(rect.height)}px tall`);
    }
    return bad;
  });
  expect(small, "tap targets are at least 44px tall").toEqual([]);
  const clipped = await content.evaluate((root) => {
    const box = root.getBoundingClientRect(); const bad: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("button, select, input, .sync-status-headline, .sync-option")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > box.right + 1 || rect.left < box.left - 1) bad.push(`${el.className || el.tagName} spills out horizontally`);
    }
    return bad;
  });
  expect(clipped, "nothing spills past the pane edge").toEqual([]);
}

for (const tag of ["@phone", "@tablet"]) {
  test(`${tag} the Sync tab is usable on a touch screen at every setup stage`, async ({ page }, testInfo) => {
    const { modal, content, errors } = await openSyncTab(page);
    const card = modal.locator(".sync-status-card");

    // Stage 1: not connected.
    await expect(card).toContainText("Sync is not set up");
    await page.screenshot({ path: testInfo.outputPath("sync-1-not-connected.png") });
    await expectUsableLayout(page, content);

    // Stage 2: provider chosen. The card now has a verb for the user, and Connection stays open.
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("probe.remote");
    await expect(modal.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("sync-2-connected.png") });
    await expectUsableLayout(page, content);

    // Stage 3: after a preview the card carries the result.
    await modal.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(card).toContainText(/Preview/);
    await content.evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("sync-3-status-card.png") });
    await expectUsableLayout(page, content);

    // Stage 4: every section open, including the scope list.
    await modal.getByRole("button", { name: /^What syncs/ }).click();
    await modal.getByRole("button", { name: /^Conflicts & issues/ }).click();
    await page.screenshot({ path: testInfo.outputPath("sync-4-sections-open.png") });
    await expectUsableLayout(page, content);
    expect(errors).toEqual([]);
  });
}

import { expect, test } from "@playwright/test";
import path from "node:path";
import { launchApp } from "../../packages/plugin-test/src/index";

// Layer B of @rbcodelabs/geode-plugin-test: the real app with a plugin loaded from a folder.
// Lives here so the sharded Electron job in verify-fast runs it; the browser layer is `npm run test:plugin-harness`.
const dir = path.resolve(__dirname, "../../packages/plugin-test/tests/fixtures/menu-plugin");

test("plugin view and Menu work in the real app", async () => {
  const h = await launchApp({ plugins: [{ id: "menu-plugin", dir }] });
  try {
    await h.openView("menu-plugin:view");
    await h.page.locator(".mp-btn").click();
    const menu = h.page.locator(".menu");
    await expect(menu.getByText("First")).toBeVisible();
    const box = (await menu.boundingBox())!;
    const vp = h.page.viewportSize()!;
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  } finally { await h.close(); }
});

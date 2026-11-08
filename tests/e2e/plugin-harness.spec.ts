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
    // Synthetic click at the bottom-right corner: the real button can sit under a sidebar.
    await h.page.dispatchEvent(".mp-btn", "click", { clientX: 1190, clientY: 790 });
    const menu = h.page.locator(".menu");
    await expect(menu.getByText("First")).toBeVisible();
    const box = (await menu.boundingBox())!;
    const vp = h.page.viewportSize()!;
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    // Anchored menu (the Agent Threads connection-pill pattern): opens directly under its anchor.
    await h.page.keyboard.press("Escape");
    const pillBox = (await h.page.locator(".mp-pill").boundingBox())!;
    await h.page.locator(".mp-pill").click();
    const m2 = (await h.page.locator(".menu").boundingBox())!;
    expect(Math.abs(m2.x - pillBox.x)).toBeLessThanOrEqual(2);
    expect(m2.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height - 2);
    expect(m2.y).toBeLessThanOrEqual(pillBox.y + pillBox.height + 8);

  } finally { await h.close(); }
});

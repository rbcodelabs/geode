import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp } from "../src/index";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/menu-plugin");

// Real Electron host (desktop layout). Needs `npm run build` at the repo root; on Linux run under xvfb-run.
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

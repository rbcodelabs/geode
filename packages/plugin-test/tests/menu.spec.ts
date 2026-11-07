import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchPlugin } from "../src/index";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/menu-plugin");

test("plugin view loads and its Menu flips to stay inside the viewport", async () => {
  const h = await launchPlugin({ plugins: [{ id: "menu-plugin", dir }] });
  try {
    await h.openView("menu-plugin:view");
    // Synthetic click at the bottom-right corner (mobile chrome overlays the real button there).
    await h.page.dispatchEvent(".mp-btn", "click", { clientX: 1270, clientY: 790 });
    const menu = h.page.locator(".menu");
    await expect(menu.getByText("First")).toBeVisible();
    await expect(menu.getByText("Second")).toBeVisible();
    const box = (await menu.boundingBox())!;
    const vp = h.page.viewportSize()!;
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

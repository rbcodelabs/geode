import { expect, test } from "@playwright/test";
import path from "node:path";
import { launchPlugin } from "../src/index";

const dir = path.join(__dirname, "fixtures/menu-plugin");

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
    // Anchored menu (the Agent Threads connection-pill pattern): opens directly under its anchor.
    await h.page.keyboard.press("Escape");
    const pillBox = (await h.page.locator(".mp-pill").boundingBox())!;
    await h.page.locator(".mp-pill").click();
    const m2 = (await h.page.locator(".menu").boundingBox())!;
    expect(Math.abs(m2.x - pillBox.x)).toBeLessThanOrEqual(2);
    expect(m2.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height - 2);
    expect(m2.y).toBeLessThanOrEqual(pillBox.y + pillBox.height + 8);
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

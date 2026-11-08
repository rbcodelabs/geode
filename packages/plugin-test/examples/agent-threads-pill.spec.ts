import { expect, test } from "@playwright/test";
import { launchApp } from "../src/index";

// Example: drive the REAL Agent Threads build in the real Geode app and open its connection-pill menu.
// Usage: AT_DIST=<agent-threads dist dir with main.js/manifest.json/styles.css> npx playwright test -c examples/playwright.config.ts
const dir = process.env.AT_DIST;
test.skip(!dir, "set AT_DIST to an Agent Threads build directory");

test("connection pill menu opens under the pill in the real app", async () => {
  const h = await launchApp({ plugins: [{ id: "claude-threads", dir: dir! }], viewport: { width: 1200, height: 800 } });
  try {
    await h.page.evaluate(() => (window as any).app.commands.executeCommandById("claude-threads:open-claude-threads"));
    await h.page.waitForSelector(".ct-input");
    // Fake only the connection: a remote thread on a daemon whose socket reports "connected".
    await h.page.evaluate(async () => {
      const plugin = (window as any).app.pluginManager.getPlugin("claude-threads");
      const manager = plugin.manager;
      const client = { connect() {}, connection: { status: "connected", attempt: 0 }, onState: () => () => {} };
      plugin.daemonRegistry = { nameOf: () => "my-server", clientFor: () => client };
      const t = manager.createThread("Pill test");
      t.remote = { daemonId: "my-server", ownership: "client", remoteCwd: "/srv/workspaces/agent-threads", lastSeq: 0, ownerClientId: "harness" };
      const leaf = (window as any).app.workspace.getLeavesOfType("claude-threads:chat")[0];
      await leaf?.view?.focusThread?.(t.id);
    });
    const pill = h.page.locator('[data-testid="remote-pill"]');
    await expect(pill).toHaveText("Connected");
    const p = (await pill.boundingBox())!;
    await pill.click();
    const menu = h.page.locator(".menu");
    await expect(menu.locator(".menu-item")).toHaveText(["Restart session", expect.stringContaining("Reconnect")]);
    const m = (await menu.boundingBox())!;
    const vp = h.page.viewportSize()!;
    expect(m.y).toBeGreaterThanOrEqual(p.y + p.height - 1);
    expect(m.y - (p.y + p.height)).toBeLessThan(8);
    expect(m.x + m.width).toBeLessThanOrEqual(vp.width);
    await h.page.screenshot({ path: process.env.PILL_SHOT ?? "pill-menu.png" });
  } finally { await h.close(); }
});

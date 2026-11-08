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
      const conn = { status: "connected", attempt: 0 };
      // Same surface the plugin's own screenshot harness fakes (test/harness/index.ts).
      plugin.daemonRegistry = {
        nameOf: () => "my-server", capabilitiesOf: () => ["host.tools", "harness.claude"], warm: async () => {},
        clientFor: () => ({ connect() {}, get connection() { return conn; } }),
        stateOf: () => conn, onState: () => () => {},
      };
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
    await expect(menu.locator(".menu-item")).toContainText(["Restart session", "Reconnect"]);
    const m = (await menu.boundingBox())!;
    const vp = h.page.viewportSize()!;
    expect(m.y).toBeGreaterThanOrEqual(p.y + p.height - 1);
    expect(m.y - (p.y + p.height)).toBeLessThan(8);
    expect(m.x + m.width).toBeLessThanOrEqual(vp.width);
    await h.page.screenshot({ path: process.env.PILL_SHOT ?? "pill-menu.png" });
  } finally { await h.close(); }
});

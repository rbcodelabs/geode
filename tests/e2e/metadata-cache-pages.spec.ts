import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("warm desktop hydration uses bounded pages and releases reload readers", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-cache-pages-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-cache-pages-user-"));
  const repo = path.resolve(__dirname, "../..");
  for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(vault, `${i}.md`), `# Note ${i}\n[[${(i + 1) % 55}]]`);
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));
  const app = await electron.launch({ args: [repo, `--user-data-dir=${userData}`], cwd: repo });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized && (window as any).app?.workspace?.layoutReady);
    await page.evaluate(async () => { await window.geode.startMetadataIndexer(); await (window as any).app.metadataCache.waitForBackgroundIdle(); });
    const protocol = await page.evaluate(async () => {
      const api = window.geode;
      const first = await api.beginMetadataCacheRead!();
      const a = await api.readMetadataCachePage!(first.token, 0);
      const b = await api.readMetadataCachePage!(first.token, 1);
      const held = await api.beginMetadataCacheRead!();
      return { a, b, token: held.token };
    });
    expect(protocol.a.examined).toBe(50); expect(protocol.a.done).toBe(false);
    expect(protocol.b.examined).toBe(5); expect(protocol.b.done).toBe(true);
    for (const response of [protocol.a, protocol.b]) expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(256 * 1024);
    await page.addInitScript(() => {
      const api = window.geode;
      const read = api.readMetadataCachePage!;
      (window as any).cacheReadCounts = { pages: 0, bulk: 0 };
      api.readMetadataCachePage = (...args) => { (window as any).cacheReadCounts.pages++; return read(...args); };
      api.readMetadataCache = async () => { (window as any).cacheReadCounts.bulk++; throw Error("Unexpected bulk hydration"); };
    });
    await page.reload();
    await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized && (window as any).app?.workspace?.layoutReady);
    expect(await page.evaluate(() => (window as any).cacheReadCounts)).toEqual({ pages: 2, bulk: 0 });
    expect(await page.evaluate(async token => {
      try { await window.geode.readMetadataCachePage!(token, 0); return false; } catch { return true; }
    }, protocol.token)).toBe(true);
    expect(await page.evaluate(() => Object.keys((window as any).app.metadataCache.resolvedLinks).length)).toBe(55);
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true });
  }
});

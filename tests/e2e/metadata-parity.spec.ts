import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { openMetadataDb, upsertHashCacheEntries, upsertMetadataEntries } from "../../src/main/metadata-cache-store";

const repoRoot = path.resolve(__dirname, "../..");
test("unchanged old-cache notes reindex with shared Markdown and property metadata", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-metadata-parity-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-metadata-parity-ud-"));
  const text = '---\nrelated: "[[Target]]"\n---\n[authored](Target.md) ![image](image.png)\n\nParagraph ^block\n\nClaim [^one]\n\n[^one]: source\n';
  fs.writeFileSync(path.join(vault, "Source.md"), text);
  fs.writeFileSync(path.join(vault, "Target.md"), "target");
  fs.writeFileSync(path.join(vault, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfF0AAAAASUVORK5CYII=", "base64"));
  const stat = fs.statSync(path.join(vault, "Source.md"));
  const db = openMetadataDb(vault);
  upsertMetadataEntries(db, { "Source.md": { mtimeMs: stat.mtimeMs, size: stat.size, metadata: { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] } } });
  upsertHashCacheEntries(db, { "Source.md": { mtimeMs: stat.mtimeMs, size: stat.size, sha256: "preserved-sync-hash", excludeReason: null, providerId: "fixture" } });
  db.exec("PRAGMA user_version = 1");
  db.close();
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => (window as any).app?.metadataCache?.getCache("Source.md")?.links.map((link: any) => link.link))).toEqual(["Target.md"]);
    const result = await page.evaluate(() => {
      const cache = (window as any).app.metadataCache;
      const metadata = cache.getCache("Source.md");
      return { properties: metadata.frontmatterLinks.map((link: any) => link.link), block: metadata.blocks.block.id, footnote: metadata.footnotes[0].id, counts: cache.resolvedLinks["Source.md"] };
    });
    expect(result).toEqual({ properties: ["Target"], block: "block", footnote: "one", counts: { "Target.md": 2, "image.png": 1 } });
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(text);
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }
});

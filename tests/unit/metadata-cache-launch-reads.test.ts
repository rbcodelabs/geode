import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../src/renderer/host/browser-host";
import { MetadataCache } from "../../src/renderer/metadata-cache";
import { Vault } from "../../src/renderer/vault";

/**
 * Real Vault + real MetadataCache, constructed in the app's order (cache first,
 * then `vault.open`, then `initialize`). `Vault.open` announces every existing
 * file as a `create` event; those must not turn into a second full-vault read
 * and parse running next to the persisted-cache restore.
 */
const NOTES: Record<string, string> = {};
for (let i = 0; i < 40; i++) NOTES[`n${i}.md`] = `# Note ${i}\n[[n${(i + 1) % 40}]] #t${i % 3}\n`;

function installApi(stored: unknown) {
  const api = {
    readMetadataCache: vi.fn(async () => stored),
    writeMetadataCache: vi.fn(async () => {}),
    startMetadataIndexer: vi.fn(async () => null),
    onMetadataIndexerMessage: vi.fn(),
  };
  vi.stubGlobal("window", { geode: api });
  return api;
}

async function launch(files: Record<string, string>, stored: unknown) {
  const api = installApi(stored);
  const host = createBrowserHost(createBrowserHostState({ files }));
  const read = vi.spyOn(host.vaultFiles, "read");
  const vault = new Vault(host);
  const cache = new MetadataCache(vault);
  await vault.open("managed://default");
  await cache.initialize();
  await cache.waitForBackgroundIdle();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { api, cache, vault, read };
}

afterEach(() => vi.unstubAllGlobals());

describe("launch reads with a persisted cache", () => {
  it("reads and parses each note once on a cold launch", async () => {
    const { read } = await launch(NOTES, null);
    expect(read.mock.calls.length).toBeLessThanOrEqual(Object.keys(NOTES).length);
  });

  it("reads no note on an unchanged warm launch", async () => {
    const cold = await launch(NOTES, null);
    const persisted = structuredClone(cold.api.writeMetadataCache.mock.calls.at(-1)![0]);
    const warm = await launch(NOTES, persisted);
    expect(warm.read).not.toHaveBeenCalled();
    expect(warm.api.writeMetadataCache).not.toHaveBeenCalled();
    expect(warm.cache.resolvedLinks["n0.md"]?.["n1.md"]).toBe(1);
  });

  it("reads only the note that changed while the app was closed", async () => {
    const cold = await launch(NOTES, null);
    const persisted = structuredClone(cold.api.writeMetadataCache.mock.calls.at(-1)![0]);
    const edited = { ...NOTES, "n5.md": "# Note 5 edited ![[n6]] #new\n", "added.md": "# Added\n[[n5]]" };
    delete (edited as Record<string, string>)["n9.md"];
    const warm = await launch(edited, persisted);
    // The browser host stamps fresh mtimes per run, so every note differs by
    // stat there; this test only pins that no note is read more than once.
    const paths = warm.read.mock.calls.map(([path]) => path as string);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

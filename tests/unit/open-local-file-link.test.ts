import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import type { HostServices } from "../../src/renderer/host/contracts";

/**
 * Regression cover for local-file links that point into an attached, read-only
 * Project root. Before this, the host only ever compared a path against the
 * vault, so anything in a Project folder was handed to the OS default
 * application even though the user had explicitly granted Geode read access —
 * clicking a Project file in an agent transcript bounced out of the app while
 * the very same file opened in the read-only viewer from the Projects tree.
 */

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function makeApp(openLocalFile: HostServices["navigation"]["openLocalFile"]) {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("document", {
    body: { classList: { contains: (name: string) => name === "theme-dark" } },
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
  });
  const host = {
    navigation: { openExternal: vi.fn(async () => {}), openLocalFile },
  } as unknown as HostServices;
  const app = new App(host);
  const openExternalResource = vi.fn(async () => {});
  (app as unknown as { openExternalResource: unknown }).openExternalResource = openExternalResource;
  return { app, openExternalResource };
}

afterEach(() => vi.unstubAllGlobals());

describe("App.openLocalFileLink", () => {
  it("opens a path inside an attached Project root in the read-only viewer", async () => {
    const ref = { rootId: "root-1", relativePath: "docs/note.md" };
    const { app, openExternalResource } = makeApp(
      vi.fn(async () => ({ kind: "external-resource", ref, rootLabel: "Compass" }) as const)
    );

    await expect(app.openLocalFileLink("/Users/rick/projects/compass/docs/note.md"))
      .resolves.toBe("external-resource");
    expect(openExternalResource).toHaveBeenCalledWith(ref, "Compass");
  });

  it("reports OS handling so a caller does not open the path a second time", async () => {
    const { app, openExternalResource } = makeApp(vi.fn(async () => ({ kind: "external" }) as const));

    await expect(app.openLocalFileLink("/tmp/elsewhere.md")).resolves.toBe("external");
    expect(openExternalResource).not.toHaveBeenCalled();
  });

  it("reports rejection so a caller may still apply its own fallback", async () => {
    const { app, openExternalResource } = makeApp(vi.fn(async () => ({ kind: "rejected" }) as const));

    await expect(app.openLocalFileLink("/tmp/missing.md")).resolves.toBe("rejected");
    expect(openExternalResource).not.toHaveBeenCalled();
  });

  it("reports rejection when a vault hit is not a real file in the index", async () => {
    const { app } = makeApp(vi.fn(async () => ({ kind: "vault", path: "gone.md" }) as const));
    vi.spyOn(app.vault, "getAbstractFileByPath").mockReturnValue(null);

    await expect(app.openLocalFileLink("/vault/gone.md")).resolves.toBe("rejected");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
import { UNLINKED_MENTIONS_SCAN } from "../../src/renderer/metadata-cache";
import { TFile } from "../../src/renderer/types";
import { BacklinksView } from "../../src/renderer/views/sidebar-views";

class FakeElement {
  className = "";
  textContent = "";
  isConnected = true;
  children: FakeElement[] = [];
  private html = "";

  set innerHTML(value: string) {
    this.html = value;
    if (!value) this.children = [];
  }
  get innerHTML(): string { return this.html; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  append(...children: FakeElement[]): void { this.children.push(...children); }
  addEventListener(): void {}
}

function file(path: string): TFile {
  const name = path.split("/").at(-1)!;
  return {
    kind: "file",
    path,
    name,
    basename: name.replace(/\.md$/, ""),
    extension: "md",
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: "",
  };
}

describe("BacklinksView unlinked-mention cancellation", () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => new FakeElement() },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  });

  it("aborts the previous exact scan when the active target changes and does not reject the stale render", async () => {
    const metadataCache = new Events() as Events & Record<PropertyKey, any>;
    metadataCache.getBacklinksWithContext = vi.fn(async () => []);
    metadataCache.isUnlinkedMentionsReady = vi.fn(() => true);
    const signals: AbortSignal[] = [];
    metadataCache[UNLINKED_MENTIONS_SCAN] = vi.fn((_target: TFile, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      if (signals.length > 1) return Promise.resolve([]);
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true }));
    });
    const workspace = new Events() as Events & Record<string, any>;
    workspace.getActiveFile = vi.fn(() => null);
    const view = new BacklinksView({ metadataCache, workspace, openFile: vi.fn() } as any);

    (view as any).file = file("A.md");
    const staleRender = view.render();
    await Promise.resolve();
    await Promise.resolve();
    (view as any).file = file("B.md");
    const currentRender = view.render();

    await expect(Promise.all([staleRender, currentRender])).resolves.toBeDefined();
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("aborts an outstanding exact scan when the view closes", async () => {
    const metadataCache = new Events() as Events & Record<PropertyKey, any>;
    metadataCache.getBacklinksWithContext = vi.fn(async () => []);
    metadataCache.isUnlinkedMentionsReady = vi.fn(() => true);
    let signal: AbortSignal | undefined;
    metadataCache[UNLINKED_MENTIONS_SCAN] = vi.fn((_target: TFile, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true }));
    });
    const workspace = new Events() as Events & Record<string, any>;
    workspace.getActiveFile = vi.fn(() => null);
    const view = new BacklinksView({ metadataCache, workspace, openFile: vi.fn() } as any);
    (view as any).file = file("A.md");

    const render = view.render();
    await Promise.resolve();
    await Promise.resolve();
    view.onClose();

    await expect(render).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a scan when Backlinks is hidden before navigation changes the active file", async () => {
    const metadataCache = new Events() as Events & Record<PropertyKey, any>;
    metadataCache.getBacklinksWithContext = vi.fn(async () => []);
    metadataCache.isUnlinkedMentionsReady = vi.fn(() => true);
    let signal: AbortSignal | undefined;
    let rejectScan: ((error: Error) => void) | undefined;
    metadataCache[UNLINKED_MENTIONS_SCAN] = vi.fn((_target: TFile, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_, reject) => {
        rejectScan = reject;
        options.signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const workspace = new Events() as Events & Record<string, any>;
    workspace.getActiveFile = vi.fn(() => null);
    const view = new BacklinksView({ metadataCache, workspace, openFile: vi.fn() } as any);
    (view as any).file = file("A.md");
    const render = view.render();
    await Promise.resolve();
    await Promise.resolve();

    try {
      (view.containerEl as any).isConnected = false;
      workspace.trigger("layout-change");
      workspace.trigger("file-open", file("B.md"));
      expect(signal?.aborted).toBe(true);
    } finally {
      if (!signal?.aborted) {
        const error = new Error("test cleanup");
        error.name = "AbortError";
        rejectScan?.(error);
      }
      await render;
    }
  });
});

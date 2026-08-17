import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MetadataIndexerHost } from "../../src/main/metadata-indexer-host";

class FakeChild extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn();
}

describe("MetadataIndexerHost", () => {
  it("resolves startup with the worker snapshot and forwards later deltas", async () => {
    const child = new FakeChild();
    const forwarded: unknown[] = [];
    const host = new MetadataIndexerHost(child, (message) => forwarded.push(message));
    const ready = host.initialize("/vault", [{ path: "A.md", mtimeMs: 1, size: 1 }]);
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "initialize", root: "/vault" }));
    const snapshot = { schemaVersion: 1, entries: {} };
    child.emit("message", { type: "snapshot", snapshot });
    await expect(ready).resolves.toBe(snapshot);
    child.emit("message", { type: "delta", path: "A.md", deleted: true });
    expect(forwarded).toEqual([{ type: "delta", path: "A.md", deleted: true }]);
  });

  it("returns null when the utility process exits before startup", async () => {
    const child = new FakeChild();
    const host = new MetadataIndexerHost(child, vi.fn());
    const ready = host.initialize("/vault", []);
    child.emit("exit", 1);
    await expect(ready).resolves.toBeNull();
  });

  it("returns null on a fatal initialization error so the renderer can fall back", async () => {
    const child = new FakeChild();
    const host = new MetadataIndexerHost(child, vi.fn());
    const ready = host.initialize("/vault", []);
    child.emit("message", { type: "error", message: "parse failed", fatal: true });
    await expect(ready).resolves.toBeNull();
  });

  it("requests a graceful cache flush before killing the process", async () => {
    const child = new FakeChild();
    const host = new MetadataIndexerHost(child, vi.fn());
    const shutdown = host.shutdown();
    expect(child.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    child.emit("message", { type: "shutdown-complete" });
    await shutdown;
    expect(child.kill).not.toHaveBeenCalled();
  });
});

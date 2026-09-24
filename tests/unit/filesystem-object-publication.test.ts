import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  pause: false,
  fail: false,
  started: () => {},
  resume: Promise.resolve(),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (!gate.pause) return actual.writeFile(...args);
      const bytes = args[1] as Uint8Array;
      await actual.writeFile(args[0], bytes.subarray(0, 1), args[2]);
      gate.started();
      await gate.resume;
      if (gate.fail) throw new Error("interrupted write");
      return actual.appendFile(args[0], bytes.subarray(1));
    },
  };
});
import { createFilesystemObjectStore } from "../../src/catalog/object-store";

let root: string;
afterEach(async () => {
  gate.pause = false;
  gate.fail = false;
  if (root) await rm(root, { recursive: true, force: true });
});

it.each([false, true])("readers never observe a partial object (existing: %s)", async (existing) => {
  root = await mkdtemp(join(tmpdir(), "geode-atomic-object-"));
  const writer = createFilesystemObjectStore(root);
  const reader = createFilesystemObjectStore(root);
  const old = new Uint8Array([1, 2, 3]);
  const next = new Uint8Array([4, 5, 6]);
  if (existing) await writer.put("v/objects/key", old, "text/plain");
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { gate.started = resolve; });
  gate.resume = new Promise<void>((resolve) => { resume = resolve; });
  gate.pause = true;
  const writing = writer.put("v/objects/key", next, "text/plain");
  await started;
  try {
    expect(await reader.get("v/objects/key")).toEqual(existing ? old : null);
    expect(await reader.list("v/")).toEqual(existing ? ["v/objects/key"] : []);
  } finally {
    resume();
    await writing;
  }
  expect(await reader.get("v/objects/key")).toEqual(next);
  expect(await readdir(join(root, "v/objects"))).toEqual(["key"]);
});

it("an interrupted put preserves the prior object and removes its partial temporary file", async () => {
  root = await mkdtemp(join(tmpdir(), "geode-atomic-object-"));
  const store = createFilesystemObjectStore(root);
  const old = new Uint8Array([1, 2, 3]);
  await store.put("v/objects/key", old, "text/plain");
  gate.pause = true;
  gate.fail = true;
  gate.resume = Promise.resolve();
  await expect(store.put("v/objects/key", new Uint8Array([4, 5, 6]), "text/plain"))
    .rejects.toThrow("interrupted write");
  expect(await store.get("v/objects/key")).toEqual(old);
  expect(await readdir(join(root, "v/objects"))).toEqual(["key"]);
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { registerVaultRemoveIpc } from "../../src/main/vault-remove-ipc";
import { withPathLock } from "../../src/main/path-lock";

it("holds the registered recursive rmdir handler behind an active sync root lock", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geode-rmdir-lock-")));
  const target = path.join(root, "Folder");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "Note.md"), "retain while sync applies");
  const handle = vi.fn();
  registerVaultRemoveIpc({ handle } as never, () => root);
  expect(handle.mock.calls[0][0]).toBe("vault-rmdir");
  const remove = handle.mock.calls[0][1];
  let unlock!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = withPathLock([root], async () => { entered(); await new Promise<void>(resolve => { unlock = resolve; }); });
  await ready;
  let completed = false;
  const removal = remove({}, "Folder", true).then(() => { completed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(completed).toBe(false);
    expect(await fs.readFile(path.join(target, "Note.md"), "utf8")).toBe("retain while sync applies");
  } finally {
    unlock();
    await Promise.all([held, removal]);
    await fs.rm(root, { recursive: true, force: true });
  }
  expect(completed).toBe(true);
});

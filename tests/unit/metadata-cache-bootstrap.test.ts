import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as store from "../../src/main/metadata-cache-store";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "metadata-bootstrap-")); roots.push(root);
  const file = join(root, store.METADATA_DB_RELATIVE_PATH); await mkdir(dirname(file), { recursive: true });
  return { root, file };
}
describe("metadata database startup ownership", () => {
  it("reproduces the captured journal transition lock with a competing reader", async () => {
    const { root, file } = await fixture();
    // This isolates SQLite's lock mechanism, not the exact utility startup
    // interleaving: the real utility also calls openMetadataDb on startup.
    const utility = new DatabaseSync(file);
    try {
      utility.exec("CREATE TABLE fixture (value INTEGER); BEGIN");
      utility.prepare("SELECT * FROM fixture").all();
      expect(utility.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
      expect(() => store.openMetadataDb(root)).toThrow(/database is locked/);
    } finally { utility.exec("ROLLBACK"); utility.close(); }
  });
  it("finishes WAL bootstrap before launching a utility reader and never awaits reconciliation", async () => {
    const { root, file } = await fixture();
    let utility: DatabaseSync | undefined;
    const ready = new Promise<true>(() => {});
    let sawWal = false;
    const bootstrap = store.bootstrapMetadataDb;
    const result = bootstrap(root, () => {
      utility = new DatabaseSync(file);
      sawWal = utility.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal";
      utility.exec("BEGIN"); utility.prepare("SELECT path FROM metadata_entries").all();
      return ready;
    });
    try {
      expect(sawWal).toBe(true); expect(result.value).toBe(ready);
      expect(result.db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    } finally { utility?.exec("ROLLBACK"); utility?.close(); result.db.close(); }
  });
  it("closes an allocated database if schema initialization fails", async () => {
    const { root } = await fixture();
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => { throw Error("bootstrap failed"); });
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => store.openMetadataDb(root)).toThrow("bootstrap failed");
    expect(close).toHaveBeenCalledOnce();
  });
  it("closes the prepared database if utility startup throws", async () => {
    const { root } = await fixture();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => store.bootstrapMetadataDb(root, () => { throw Error("fork failed"); })).toThrow("fork failed");
    expect(close).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMetadataDb, upsertMetadataEntries } from "../../src/main/metadata-cache-store";
import { MetadataCacheReaders } from "../../src/main/metadata-cache-reader";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const entry = { mtimeMs: 1, size: 1, metadata: { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] } };
async function fixture() { const root = await mkdtemp(join(tmpdir(), "cache-reader-")); roots.push(root); return { root, db: openMetadataDb(root), readers: new MetadataCacheReaders() }; }

describe("bounded metadata readers", () => {
  it("pins a snapshot at begin and traverses at most 50 rows between turns", async () => {
    const { root, db, readers } = await fixture();
    try {
      upsertMetadataEntries(db, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [String(i).padStart(3, "0") + ".md", entry])));
      const begin = readers.begin(1, root, 1);
      upsertMetadataEntries(db, { "000.md": { ...entry, size: 9 }, "new.md": entry });
      const first = readers.page(1, 1, begin.token, 0);
      expect(first.examined).toBe(50); expect(first.entries["000.md"].size).toBe(1); expect(first.done).toBe(false);
      let yielded = false; await new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
      expect(yielded).toBe(true);
      const last = readers.page(1, 1, begin.token, 1);
      expect(Object.keys(last.entries)).toEqual(["050.md"]); expect(last.done).toBe(true);
      expect(() => readers.page(1, 1, begin.token, 2)).toThrow();
      expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
    } finally { readers.closeAll(); db.close(); }
  });
  it("bounds Unicode payloads and advances corrupt or oversized rows", async () => {
    const { root, db, readers } = await fixture();
    try {
      const insert = db.prepare("INSERT INTO metadata_entries VALUES (?,1,1,?,NULL)");
      for (let i = 0; i < 51; i++) insert.run(String(i).padStart(3, "0"), i % 2 ? "bad JSON" : JSON.stringify({ ...entry.metadata, frontmatter: { value: "空".repeat(100000) } }));
      upsertMetadataEntries(db, { '最後".md': entry });
      const { token } = readers.begin(1, root, 1);
      const first = readers.page(1, 1, token, 0);
      expect(first.examined).toBe(50); expect(first.omitted.corrupt + first.omitted.oversized).toBe(50);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(256 * 1024);
      const last = readers.page(1, 1, token, 1);
      expect(last.entries['最後".md']).toEqual(entry); expect(last.done).toBe(true);
    } finally { readers.closeAll(); db.close(); }
  });
  it("isolates owners, sessions, replacements and cancellation", async () => {
    const { root, db, readers } = await fixture();
    try {
      const a = readers.begin(1, root, 1);
      expect(() => readers.page(2, 1, a.token, 0)).toThrow();
      expect(() => readers.page(1, 2, a.token, 0)).toThrow();
      const b = readers.begin(1, root, 1);
      expect(() => readers.page(1, 1, a.token, 0)).toThrow();
      expect(() => readers.page(1, 1, b.token, 1)).toThrow();
      expect(() => readers.page(1, 1, b.token, 0)).toThrow();
      const c = readers.begin(1, root, 1); readers.cancel(1, 1, c.token); readers.cancel(1, 1, c.token);
      expect(() => readers.page(1, 1, c.token, 0)).toThrow();
    } finally { readers.closeAll(); db.close(); }
  });
  it("expires idle readers and closes an empty snapshot on its first page", async () => {
    const { root, db, readers } = await fixture();
    try {
      vi.useFakeTimers();
      const { token } = readers.begin(1, root, 1);
      await vi.advanceTimersByTimeAsync(30000);
      expect(() => readers.page(1, 1, token, 0)).toThrow();
      const next = readers.begin(1, root, 1);
      expect(readers.page(1, 1, next.token, 0)).toMatchObject({ entries: {}, done: true, examined: 0 });
    } finally { readers.closeAll(); db.close(); }
  });
  it("enforces the total lifetime despite successful reads and releases owners independently", async () => {
    const { root, db, readers } = await fixture();
    try {
      upsertMetadataEntries(db, Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i).padStart(4, "0"), entry])));
      vi.useFakeTimers();
      const a = readers.begin(1, root, 1), b = readers.begin(2, root, 1);
      readers.closeOwner(2);
      expect(() => readers.page(2, 1, b.token, 0)).toThrow();
      for (let sequence = 0; sequence < 10; sequence++) {
        await vi.advanceTimersByTimeAsync(29000);
        expect(readers.page(1, 1, a.token, sequence).done).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(10000);
      expect(() => readers.page(1, 1, a.token, 10)).toThrow();
      expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
    } finally { readers.closeAll(); db.close(); }
  });
  it("keeps every full envelope bounded when near-limit entries precede omissions", async () => {
    const { root, db, readers } = await fixture();
    try {
      const insert = db.prepare("INSERT INTO metadata_entries VALUES (?,1,1,?,NULL)");
      // Escaped Unicode path and dense payload bring the response close to its limit.
      insert.run('000空"', JSON.stringify({ ...entry.metadata, frontmatter: { value: "x".repeat(261000) } }));
      for (let i = 1; i <= 51; i++) insert.run(String(i).padStart(3, "0"), "invalid");
      const { token } = readers.begin(1, root, 1);
      let sequence = 0, seen = 0;
      while (true) {
        const page = readers.page(1, 1, token, sequence++);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024);
        expect(page.examined).toBeLessThanOrEqual(50); seen += page.examined;
        if (page.done) break;
      }
      expect(seen).toBe(52);
    } finally { readers.closeAll(); db.close(); }
  });
  it("rejects a database with an unsupported persisted schema", async () => {
    const { root, db, readers } = await fixture();
    try {
      db.exec("PRAGMA user_version = 999");
      expect(() => readers.begin(1, root, 1)).toThrow(/schema/);
    } finally { readers.closeAll(); db.close(); }
  });
  it("ends and releases the reader on an operational row-fetch error", async () => {
    const { root, db, readers } = await fixture();
    try {
      upsertMetadataEntries(db, { "A.md": entry });
      const { token } = readers.begin(1, root, 1);
      const connection = (readers as any).readers.get(1).db;
      const prepare = connection.prepare.bind(connection);
      vi.spyOn(connection, "prepare").mockImplementation((sql: string) => {
        if (sql.startsWith("SELECT metadata_json")) throw Error("disk read failed");
        return prepare(sql);
      });
      expect(() => readers.page(1, 1, token, 0)).toThrow("disk read failed");
      expect(() => readers.page(1, 1, token, 0)).toThrow(/Invalid/);
      expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
    } finally { readers.closeAll(); db.close(); }
  });
  it("accepts the byte-boundary pair and defers an entry one byte beyond it", async () => {
    const { root, db, readers } = await fixture();
    try {
      const a = { ...entry, metadata: { ...entry.metadata, frontmatter: { text: "x".repeat(130000) } } };
      const b = { ...entry, metadata: { ...entry.metadata, frontmatter: { text: "" } } };
      const envelope = { schemaVersion: 1, sequence: 0, entries: { 'A空".md': a, "B.md": b }, examined: 50, omitted: { corrupt: 50, oversized: 50 }, done: false };
      const remaining = 256 * 1024 - Buffer.byteLength(JSON.stringify(envelope));
      for (const extra of [0, 1]) {
        b.metadata.frontmatter.text = "x".repeat(remaining + extra);
        upsertMetadataEntries(db, { 'A空".md': a, "B.md": b, "C.md": entry });
        const { token } = readers.begin(1, root, 1);
        const page = readers.page(1, 1, token, 0);
        expect(Object.keys(page.entries)).toEqual(extra ? ['A空".md'] : ['A空".md', "B.md"]);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024);
        expect(page.omitted).toEqual({ corrupt: 0, oversized: 0 });
        readers.cancel(1, 1, token);
      }
    } finally { readers.closeAll(); db.close(); }
  });
});

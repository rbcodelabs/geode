import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePublication, type ValidatedPublication } from "../../src/wiki/catalog-contract";
import {
  assertOwnableSchema,
  classifyFailure,
  createDsqlCatalog,
  decodeColumn,
  DSQL_CATALOG_LIMITS,
  isRetryable,
  literal,
  parseDsqlRows,
  readObjectForRestore,
  sqlStateOf,
  type Preflight,
} from "../../src/catalog/dsql-catalog-store";
import { createMemoryObjectStore, type ObjectStore } from "../../src/catalog/object-store";

/**
 * The DSQL adapter, without a database.
 *
 * Everything here is either pure or generates SQL. The behaviour that needs a
 * server lives in `scripts/dsql-catalog-publish-proof.mts` and the two-process
 * harness; this file covers the parts a proof would have to reach through a
 * transaction to exercise, and the retry classification in particular, where a
 * wrong answer turns a recoverable race into a spurious refusal.
 */

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const pngBytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);

function publication(overrides: Partial<Parameters<typeof validatePublication>[0]> = {}): ValidatedPublication {
  const result = validatePublication({
    vaultId: "vault-a",
    mutationId: "m1",
    baseSequence: 3,
    notes: [{ path: "It's here.md", text: "a 'quoted' note\nwith a newline" }],
    assets: [{ path: "assets/a.png", contentAddress: sha(pngBytes), contentType: "image/png", bytes: pngBytes }],
    ...overrides,
  }, { limits: DSQL_CATALOG_LIMITS });
  if (result.status !== "ok") throw new Error(`fixture failed to validate: ${result.status}`);
  return result.publication;
}

const emptyPreflight: Preflight = { receipt: null, currentSequence: 3, existingObjects: new Map() };
const catalog = () => createDsqlCatalog({ schema: "geode_test", objects: createMemoryObjectStore() });

describe("driver-backed query execution", () => {
  it("runs schema-scoped SQL without psql commands and preserves row whitespace", async () => {
    const calls: string[] = [];
    const db = createDsqlCatalog({
      schema: "geode_test", psql: "/no-psql-in-vercel",
      executeSql: async (sql: string) => { calls.push(sql); return "E\t Draft.md\t \n"; },
    });
    await expect(db.query("SELECT 'proof';")).resolves.toBe("E\t Draft.md\t \n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("SET search_path TO geode_test;");
    expect(calls[0]).not.toContain("SET standard_conforming_strings");
    expect(calls[0]).not.toContain("SET statement_timeout");
    expect(calls[0]).not.toContain("\\set");
  });
});

describe("literal", () => {
  it("doubles single quotes and leaves everything else alone", () => {
    expect(literal("It's here")).toBe("'It''s here'");
    // Backslashes are safe only because the session sets
    // `standard_conforming_strings = on`; with it off this would escape the
    // closing quote. The adapter sets it explicitly rather than inheriting it.
    expect(literal("a\\b")).toBe("'a\\b'");
  });
});

describe("assertOwnableSchema", () => {
  it.each([["public"], ["information_schema"], ["pg_catalog"], ["sys"], ["Mixed"], ["has-dash"], [""]])(
    "refuses %s", (schema) => { expect(() => assertOwnableSchema(schema)).toThrow(/GEODE_CATALOG/); },
  );

  it("accepts a plain lowercase identifier", () => {
    expect(assertOwnableSchema("geode_dsql_abc123")).toBe("geode_dsql_abc123");
  });

  it("refuses sys, which the PostgreSQL adapter has no reason to know about", () => {
    // DSQL exposes its own catalog views in `sys`. A `GEODE_CATALOG_SCHEMA=sys`
    // typo must not be expressible, not merely unlikely.
    expect(() => assertOwnableSchema("sys")).toThrow();
  });
});

describe("sqlStateOf and isRetryable", () => {
  it.each([
    ["ERROR:  23505: duplicate key value violates unique constraint \"vault_sequence_pkey\"", "23505"],
    ["ERROR:  40001: could not serialize access due to concurrent update", "40001"],
    ["ERROR:  OC001: change conflicts with another transaction", "OC001"],
  ])("reads the SQLSTATE out of %s", (message, state) => {
    expect(sqlStateOf(message)).toBe(state);
  });

  it("returns null when the server reported no SQLSTATE", () => {
    expect(sqlStateOf("ERROR:  something went wrong")).toBeNull();
  });

  it.each([["23505"], ["40001"], ["40P01"], ["OC000"], ["OC001"]])("treats %s as retryable", (state) => {
    expect(isRetryable(`ERROR:  ${state}: whatever`)).toBe(true);
  });

  it.each([["23514"], ["42P01"], ["22P02"], ["53300"]])("treats %s as terminal", (state) => {
    // A check-constraint violation, a missing table, a bad cast and a
    // connection limit are all real failures. Retrying them would turn one
    // clear error into five slow ones.
    expect(isRetryable(`ERROR:  ${state}: whatever`)).toBe(false);
  });

  it("falls back to the wire text when no SQLSTATE is present", () => {
    // A missed retry here turns a recoverable race into a spurious refusal, so
    // the fallback errs toward retrying.
    expect(isRetryable("ERROR:  could not serialize access due to concurrent update")).toBe(true);
    expect(isRetryable("ERROR:  duplicate key value violates unique constraint")).toBe(true);
    expect(isRetryable("ERROR:  deadlock detected")).toBe(true);
    expect(isRetryable("psql: error: connection to server failed")).toBe(false);
  });
});

describe("classifyFailure", () => {
  it("names the refusals the contract knows", () => {
    expect(classifyFailure("ERROR:  GEODE_CATALOG:CONFLICT")).toBe("conflict");
    expect(classifyFailure("ERROR:  GEODE_CATALOG:MUTATION_ID_REUSED")).toBe("mutation-id-reused");
  });

  it("does not paper over a failure it cannot name", () => {
    expect(classifyFailure("ERROR:  42P01: relation \"object\" does not exist")).toBe("store-failed");
    expect(classifyFailure("")).toBe("store-failed");
  });
});

describe("decodeColumn", () => {
  it("round-trips the escapes the server-side encoder emits", () => {
    expect(decodeColumn("a\\nb")).toBe("a\nb");
    expect(decodeColumn("a\\tb")).toBe("a\tb");
    expect(decodeColumn("a\\rb")).toBe("a\rb");
    expect(decodeColumn("a\\\\b")).toBe("a\\b");
  });

  it("reads \\0 as NULL, which the encoder itself can never produce", () => {
    expect(decodeColumn("\\0")).toBeNull();
    expect(decodeColumn("")).toBe("");
  });

  it("survives a value that is entirely escapes", () => {
    expect(decodeColumn("\\n\\t\\\\")).toBe("\n\t\\");
  });
});

describe("parseDsqlRows", () => {
  it("does not treat legal path text as a result-set separator", () => {
    expect(validatePublication({
      vaultId: "vault-a",
      mutationId: "sentinel-path",
      baseSequence: 0,
      notes: [{ path: "folder/__GEODE_SPLIT__/note.md", text: "safe" }],
      assets: [],
    }).status).toBe("ok");
    const rows = parseDsqlRows(
      "S\t4\n" +
      "E\tfolder/__GEODE_SPLIT__/note.md\tnote\taddress\ttext/markdown\t12\tobject-key\n",
    );

    expect(rows.get("S")).toEqual([["4"]]);
    expect(rows.get("E")?.[0]?.[0]).toBe("folder/__GEODE_SPLIT__/note.md");
  });

  it("preserves leading whitespace in an encoded path", () => {
    expect(validatePublication({
      vaultId: "vault-a",
      mutationId: "space-path",
      baseSequence: 0,
      notes: [{ path: " Draft.md", text: "safe" }],
      assets: [],
    }).status).toBe("ok");
    const rows = parseDsqlRows("E\t Draft.md\tnote\taddress\ttext/markdown\t12\tobject-key\n");
    expect(rows.get("E")?.[0]?.[0]).toBe(" Draft.md");
  });
});

describe("readObjectForRestore", () => {
  const address = sha(new TextEncoder().encode("expected"));
  const key = `vault-a/objects/${address}`;

  it("reports an object-store outage as store-failed, not missing-object", async () => {
    const failing: ObjectStore = {
      async put() { throw new Error("not used"); },
      async get() { throw new Error("temporary outage"); },
      async delete() { throw new Error("not used"); },
      async list() { throw new Error("not used"); },
    };

    expect(await readObjectForRestore(failing, key, address)).toEqual({ status: "store-failed" });
  });

  it("keeps absence distinct from corrupt bytes", async () => {
    const absent = createMemoryObjectStore();
    expect(await readObjectForRestore(absent, key, address)).toEqual({ status: "missing-object" });

    const corrupt = createMemoryObjectStore();
    await corrupt.put(key, new TextEncoder().encode("different"), "text/markdown");
    expect(await readObjectForRestore(corrupt, key, address)).toEqual({ status: "invalid-content-address" });
  });
});

describe("publishSql", () => {
  const sql = (pre: Preflight = emptyPreflight) => catalog().publishSql(publication(), pre);

  it("claims the sequence slot before anything else", () => {
    // The uniqueness of (vault_id, sequence) is the whole serialization
    // mechanism. If it stopped being the first statement, a losing racer could
    // write catalog entries before discovering it had lost.
    expect(sql().trimStart().startsWith("INSERT INTO vault_sequence")).toBe(true);
    expect(sql()).toContain("VALUES ('vault-a', 4, 'm1')");
  });

  it("writes the receipt last", () => {
    const statements = sql().trim().split("\n");
    expect(statements[statements.length - 1]).toContain("INSERT INTO receipt");
  });

  it("content-addresses note text as well as asset bytes", () => {
    const noteAddress = sha(new TextEncoder().encode("a 'quoted' note\nwith a newline"));
    expect(sql()).toContain(literal(noteAddress));
    expect(sql()).toContain(literal(sha(pngBytes)));
  });

  it("escapes a quoted path and quoted note text", () => {
    expect(sql()).toContain("'It''s here.md'");
  });

  it("records each entry's own content type rather than the shared object's", () => {
    expect(sql()).toContain("'It''s here.md', 'note'");
    expect(sql()).toMatch(/'assets\/a\.png', 'attachment'.*'image\/png'/);
  });

  it("deletes the claimed paths before inserting them", () => {
    const text = sql();
    expect(text.indexOf("DELETE FROM catalog_entry")).toBeLessThan(text.indexOf("INSERT INTO catalog_entry"));
    // DELETE-then-INSERT rather than an upsert: this adapter depends on no
    // `ON CONFLICT` semantics it has not observed, and DELETE is the only
    // truncation DSQL supports at all.
    expect(text).not.toMatch(/ON CONFLICT/i);
  });

  it("skips object rows the preflight already found", () => {
    const address = sha(pngBytes);
    const noteAddress = sha(new TextEncoder().encode("a 'quoted' note\nwith a newline"));
    const pre: Preflight = {
      receipt: null, currentSequence: 3,
      existingObjects: new Map([
        [address, { byteLength: pngBytes.byteLength, objectKey: `vault-a/objects/${address}` }],
        [noteAddress, { byteLength: 30, objectKey: `vault-a/objects/${noteAddress}` }],
      ]),
    };
    // Every object already recorded: no INSERT INTO object at all.
    expect(sql(pre)).not.toContain("INSERT INTO object");
  });

  it("emits no INSERT for an empty entry list", () => {
    // Not reachable through `publish` — the contract refuses an
    // `empty-publication` before the adapter is contacted — but a malformed
    // statement is worse than a refused one, so the generator stays total.
    const empty = { ...publication(), notes: [], assets: [] } as ValidatedPublication;
    const text = catalog().publishSql(empty, emptyPreflight);
    expect(text).not.toContain("INSERT INTO catalog_entry");
    expect(text).toContain("INSERT INTO vault_sequence");
    expect(text).toContain("INSERT INTO receipt");
  });

  it("stores the receipt as JSON text carrying the sequence it claimed", () => {
    expect(sql()).toContain("\"sequence\":4");
    expect(sql()).toContain("\"noteCount\":1");
    expect(sql()).toContain("\"assetCount\":1");
  });

  it("folds two paths with identical bytes onto one object row", () => {
    const shared = publication({
      notes: [{ path: "a.md", text: "same" }, { path: "b.md", text: "same" }],
      assets: [],
    });
    const text = catalog().publishSql(shared, emptyPreflight);
    expect(text.match(/VALUES \('vault-a', '[0-9a-f]{64}', 'text\/markdown'/g)).toHaveLength(1);
    expect(text.match(/'a\.md'|'b\.md'/g)).toHaveLength(4); // two deletes, two inserts
  });
});

describe("DSQL_CATALOG_LIMITS", () => {
  it("caps entries low enough that one publication stays under 3,000 modified rows", () => {
    // A publication modifies up to `entries` deletes + `entries` inserts +
    // `entries` object rows + one sequence row + one receipt row.
    const worstCase = DSQL_CATALOG_LIMITS.maxPublicationEntries * 3 + 2;
    expect(worstCase).toBeLessThanOrEqual(3000);
  });

  it("is tighter than the contract default on entries and no tighter elsewhere", () => {
    expect(DSQL_CATALOG_LIMITS.maxPublicationEntries).toBe(500);
    // Bytes no longer travel through the database, so the byte ceilings have
    // no reason to shrink.
    expect(DSQL_CATALOG_LIMITS.maxPublicationBytes).toBe(64 * 1024 * 1024);
  });

  it("refuses an already-validated oversized publication before database I/O", async () => {
    const validation = validatePublication({
      vaultId: "vault-a",
      mutationId: "too-many",
      baseSequence: 0,
      notes: Array.from(
        { length: DSQL_CATALOG_LIMITS.maxPublicationEntries + 1 },
        (_unused, index) => ({ path: `n${index}.md`, text: `${index}` }),
      ),
      assets: [],
    });
    expect(validation.status).toBe("ok");
    if (validation.status !== "ok") throw new Error("fixture must pass the portable default limits");

    await expect(catalog().store.commit(validation.publication)).resolves.toEqual({
      status: "entry-limit",
      observed: DSQL_CATALOG_LIMITS.maxPublicationEntries + 1,
      allowed: DSQL_CATALOG_LIMITS.maxPublicationEntries,
    });
  });
});

describe("uploadObjects", () => {
  it("puts note bytes and asset bytes alike, before any catalog row references them", async () => {
    const objects = createMemoryObjectStore();
    const store = createDsqlCatalog({ schema: "geode_test", objects });
    expect(await store.uploadObjects(publication())).toEqual({ status: "ok" });
    // One note, one asset, two distinct objects.
    expect(objects.size()).toBe(2);
    expect(await objects.list("vault-a/")).toHaveLength(2);
  });

  it("refuses when the store already holds different bytes at an address", async () => {
    const objects = createMemoryObjectStore();
    await objects.put(`vault-a/objects/${sha(pngBytes)}`, new Uint8Array([7, 7]), "image/png");
    const store = createDsqlCatalog({ schema: "geode_test", objects });
    expect(await store.uploadObjects(publication())).toEqual({ status: "duplicate-with-mismatched-bytes" });
  });

  it("is safe to repeat, which is what makes a retry cheap", async () => {
    const objects = createMemoryObjectStore();
    const store = createDsqlCatalog({ schema: "geode_test", objects });
    await store.uploadObjects(publication());
    await store.uploadObjects(publication());
    expect(objects.size()).toBe(2);
  });
});

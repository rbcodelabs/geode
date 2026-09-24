import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePublication, type ValidatedPublication } from "../../src/wiki/catalog-contract";
import {
  assertOwnableSchema,
  classifyFailure,
  createPostgresCatalog,
  literal,
} from "../../src/catalog/postgres-catalog-store";
import { continuationByteOffset, writeFakePsql, type FakePsql } from "../helpers/fake-psql";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);

function publication(): ValidatedPublication {
  const result = validatePublication({
    vaultId: "vault-a",
    mutationId: "m1",
    baseSequence: 3,
    notes: [{ path: "It's here.md", text: "a 'quoted' note\nwith a newline" }],
    assets: [{ path: "assets/a.png", contentAddress: sha(bytes), contentType: "image/png", bytes }],
  });
  if (result.status !== "ok") throw new Error(`fixture failed to validate: ${result.status}`);
  return result.publication;
}

describe("classifyFailure", () => {
  it.each([
    ["ERROR:  GEODE_CATALOG:CONFLICT", "conflict"],
    ["ERROR:  GEODE_CATALOG:MUTATION_ID_REUSED", "mutation-id-reused"],
    ["ERROR:  GEODE_CATALOG:DUPLICATE_WITH_MISMATCHED_BYTES", "duplicate-with-mismatched-bytes"],
    ["ERROR:  GEODE_CATALOG:INVALID_CONTENT_ADDRESS", "invalid-content-address"],
  ])("maps %s onto its own named status", (message, expected) => {
    expect(classifyFailure(message)).toBe(expected);
  });

  it("does not mistake an echoed SQL statement for a refusal", () => {
    // The schema uses `ON CONFLICT DO NOTHING` in several statements. A
    // classifier matching the bare word would report `conflict` for an
    // unrelated failure that happened to quote one of them back.
    expect(classifyFailure('ERROR:  null value violates not-null constraint\nCONTEXT: INSERT ... ON CONFLICT DO NOTHING'))
      .toBe("store-failed");
  });

  it("reports store-failed for an injected failure and for an unreachable server", () => {
    expect(classifyFailure("ERROR:  GEODE_CATALOG:INJECTED_FAILURE")).toBe("store-failed");
    expect(classifyFailure("could not connect to server: Connection refused")).toBe("store-failed");
  });
});

describe("literal", () => {
  it("doubles embedded single quotes and leaves everything else alone", () => {
    expect(literal("It's")).toBe("'It''s'");
    expect(literal("a\\b")).toBe("'a\\b'");
  });
});

describe("publishSql", () => {
  const catalog = createPostgresCatalog({ schema: "unit_test_schema" });
  const sql = catalog.publishSql(publication());

  it("passes the contract's digest and base sequence through verbatim", () => {
    expect(sql).toContain(literal(publication().digest));
    expect(sql).toContain(", 3, ");
  });

  it("sends asset bytes as hex for server-side decoding rather than embedding binary in JSON", () => {
    expect(sql).toContain("0001feff");
    expect(sql).not.toContain("þ");
  });

  it("escapes a note path and body containing single quotes", () => {
    // JSON.stringify produces the payload; `literal` then has to survive the
    // apostrophes inside it, or the statement would terminate early.
    expect(sql).toContain("It''s here.md");
    expect(sql).toContain("a ''quoted'' note");
  });

  it("defaults the injected-failure flag off", () => {
    expect(sql.trimEnd().endsWith("false);")).toBe(true);
    expect(catalog.publishSql(publication(), { fail: true }).trimEnd().endsWith("true);")).toBe(true);
  });
});

describe("publishSql — pre-receipt injection", () => {
  const catalog = createPostgresCatalog({ schema: "unit_test_schema" });

  it("omits the eighth argument entirely unless the pre-receipt failure is asked for", () => {
    // The schema default carries the common case, so the SQL an ordinary
    // publication generates is byte-identical to the SQL generated before the
    // injection point existed.
    expect(catalog.publishSql(publication()).trimEnd().endsWith("false);")).toBe(true);
    expect(catalog.publishSql(publication())).not.toContain("false, ");
  });

  it("appends it when asked, alongside the existing post-receipt flag", () => {
    expect(catalog.publishSql(publication(), { failBeforeReceipt: true }).trimEnd().endsWith("false, true);")).toBe(true);
    expect(catalog.publishSql(publication(), { fail: true, failBeforeReceipt: true }).trimEnd().endsWith("true, true);")).toBe(true);
  });
});

describe("assertOwnableSchema", () => {
  it("accepts the disposable schema names the proofs generate", () => {
    expect(assertOwnableSchema("geode_catalog_0f2a9c")).toBe("geode_catalog_0f2a9c");
    expect(assertOwnableSchema("unit_test_schema")).toBe("unit_test_schema");
  });

  it.each([
    ["public", "the schema a typo in GEODE_CATALOG_SCHEMA most plausibly lands on"],
    ["information_schema", "a system catalog"],
    ["pg_temp", "a reserved pg_ name"],
    ["pg_catalog", "a reserved pg_ name"],
  ])("refuses %s — %s", (schema) => {
    expect(() => assertOwnableSchema(schema)).toThrow(/not a schema this adapter may create or drop/);
  });

  it.each([
    ["has spaces"],
    ['a"; DROP SCHEMA other CASCADE; --'],
    ["Mixed_Case"],
    [""],
    ["1leading_digit"],
    ["x".repeat(64)],
  ])("refuses %j as an identifier", (schema) => {
    expect(() => assertOwnableSchema(schema)).toThrow(/not a plain lowercase SQL identifier/);
  });

  it("refuses at construction, before any statement can be built", () => {
    // `drop()` interpolates the schema into `DROP SCHEMA IF EXISTS ... CASCADE`.
    // The refusal has to happen at the factory, or a caller holds an object
    // whose only remaining behaviour is to run that statement.
    expect(() => createPostgresCatalog({ schema: "public" })).toThrow(/GEODE_CATALOG/);
  });
});

describe("the session prefix", () => {
  let fake: FakePsql;
  beforeAll(async () => { fake = await writeFakePsql(); });
  afterAll(async () => { await rm(fake.directory, { recursive: true, force: true }); });

  it("pins standard_conforming_strings rather than depending on the server default", async () => {
    // `literal()` doubles quotes and nothing else, which is only correct while
    // this setting is on. It is reachable from `postgresql.conf` and from
    // `PGOPTIONS`; `psql -X` only rules out `.psqlrc`. Note text is fully
    // caller-controlled and flows through `literal()`, so the adapter states
    // the setting it depends on instead of inheriting it.
    const catalog = createPostgresCatalog({
      schema: "prefix_probe",
      psql: fake.path,
      env: { ...process.env, FAKE_PSQL_MODE: "echo" },
    });
    try {
      const echoed = await catalog.query("SELECT 1;");
      expect(echoed).toContain("SET standard_conforming_strings = on;");
      expect(echoed).toContain("SET search_path TO prefix_probe;");
    } finally {
      catalog.close();
    }
  });
});

describe("reading a restore across a pipe chunk boundary", () => {
  let fake: FakePsql;
  beforeAll(async () => { fake = await writeFakePsql(); });
  afterAll(async () => { await rm(fake.directory, { recursive: true, force: true }); });

  /**
   * Note text made of two-, three- and four-byte characters, big enough that
   * the encoded payload runs past several 64 KiB pipe reads on its own.
   */
  const noteText = (() => {
    const lines: string[] = ["# Wide note\n"];
    for (let index = 0; index < 4000; index += 1) {
      lines.push(`Ωμέγα ${index} ✦ Привет 🝮 ${"🝮".repeat(index % 7)}${"✦".repeat(index % 5)}\n`);
    }
    return lines.join("");
  })();

  async function restoreThroughFakePsql(): Promise<{ text: string; payloadBytes: number; split: number }> {
    const payload = Buffer.from(JSON.stringify({
      vaultId: "vault-wide",
      sequence: 1,
      entries: [{ path: "notes/Wide note.md", kind: "note", text: noteText }],
    }), "utf8");
    // Force one boundary that provably bisects a character, on top of whatever
    // the OS does with a payload this size. Deriving the offset from the bytes
    // keeps the test honest if the fixture text ever changes.
    const split = continuationByteOffset(payload, payload.length >> 1);
    expect(payload[split]! & 0xc0).toBe(0x80);
    expect(payload.byteLength).toBeGreaterThan(64 * 1024);

    const payloadPath = join(fake.directory, "payload.json");
    await writeFile(payloadPath, payload);
    const catalog = createPostgresCatalog({
      schema: "wide_probe",
      psql: fake.path,
      env: {
        ...process.env,
        FAKE_PSQL_MODE: "payload",
        FAKE_PSQL_PAYLOAD: payloadPath,
        FAKE_PSQL_SPLIT: String(split),
      },
    });
    try {
      const result = await catalog.restoreSource().restore("vault-wide");
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.vault.notes).toHaveLength(1);
      return { text: result.vault.notes[0]!.text, payloadBytes: payload.byteLength, split };
    } finally {
      catalog.close();
    }
  }

  it("returns the note text byte-for-byte, with no replacement characters", async () => {
    // The regression: `stdout += chunk` decodes every Buffer independently, so
    // a character straddling a chunk boundary becomes U+FFFD. Nothing
    // downstream catches it — every JSON structural character is ASCII, so
    // `JSON.parse` still succeeds, and a note has no content address for
    // `verifyRestoredVault` to check. The corrupted text goes to disk.
    const { text, payloadBytes, split } = await restoreThroughFakePsql();
    expect(payloadBytes).toBeGreaterThan(64 * 1024);
    expect(split).toBeGreaterThan(0);
    expect(text).toBe(noteText);
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text, "utf8")).toBe(Buffer.byteLength(noteText, "utf8"));
  }, 30_000);
});

describe("failure paths that need no database", () => {
  it("reports store-failed when psql cannot be executed at all", async () => {
    const catalog = createPostgresCatalog({ schema: "unit_test_schema", psql: "/nonexistent/psql" });
    try {
      expect(await catalog.store.commit(publication())).toEqual({ status: "store-failed" });
    } finally {
      catalog.close();
    }
  });

  it("reports store-failed rather than throwing when a restore cannot reach the store", async () => {
    // A restore has no named database-side refusals, so an unreachable server
    // has exactly one honest answer — and it must be an answer, not an
    // exception escaping the port.
    const catalog = createPostgresCatalog({ schema: "unit_test_schema", psql: "/nonexistent/psql" });
    try {
      expect(await catalog.restoreSource().restore("vault-a")).toEqual({ status: "store-failed" });
    } finally {
      catalog.close();
    }
  });
});

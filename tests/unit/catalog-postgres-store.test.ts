import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePublication, type ValidatedPublication } from "../../src/wiki/catalog-contract";
import { classifyFailure, createPostgresCatalog, literal } from "../../src/catalog/postgres-catalog-store";

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

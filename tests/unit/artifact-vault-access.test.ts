import { describe, expect, it } from "vitest";
import {
  compileVaultAllowlist,
  normalizeVaultRelativePath,
  parseVaultQueryRequest,
  validateVaultAllowlistEntry,
  VAULT_QUERY_DEFAULT_ROW_LIMIT,
  VAULT_QUERY_MAX_ROW_LIMIT,
} from "../../src/artifacts/vault-access";

describe("normalizeVaultRelativePath", () => {
  it.each([
    ["../secret.base", "dot_segment"],
    ["a/../../secret.base", "dot_segment"],
    ["a/./b.base", "dot_segment"],
    ["/etc/passwd", "absolute"],
    ["C:/Users/x.base", "drive_letter"],
    ["a\\b.base", "backslash"],
    ["a//b.base", "empty_segment"],
    ["a/b.base/", "empty_segment"],
    ["a\0b.base", "control"],
    ["", "empty"],
  ])("rejects %j", (input, issue) => {
    expect(normalizeVaultRelativePath(input)).toEqual({ ok: false, issue });
  });

  it("accepts ordinary vault-relative paths and never rewrites them", () => {
    expect(normalizeVaultRelativePath("Projects/Tasks.base")).toEqual({ ok: true, path: "Projects/Tasks.base" });
    expect(normalizeVaultRelativePath("Folder/", { allowTrailingSlash: true })).toEqual({ ok: true, path: "Folder/" });
  });

  it("rejects non-strings and over-long input", () => {
    expect(normalizeVaultRelativePath(42)).toEqual({ ok: false, issue: "empty" });
    expect(normalizeVaultRelativePath("a".repeat(600))).toEqual({ ok: false, issue: "too_long" });
  });
});

describe("validateVaultAllowlistEntry", () => {
  it.each(["**", "**/*", "*", "../x.base", "/abs.base", "a\\b", ""])("rejects %j", (entry) => {
    expect(validateVaultAllowlistEntry(entry)).not.toBeNull();
  });
  it.each(["Tasks.base", "Projects/", "Projects/**", "**/*.base", "Bases/*.base"])("accepts %j", (entry) => {
    expect(validateVaultAllowlistEntry(entry)).toBeNull();
  });
});

describe("compileVaultAllowlist", () => {
  it("matches exact paths case-sensitively", () => {
    const list = compileVaultAllowlist(["Tasks.base"]);
    expect(list.matches("Tasks.base")).toBe(true);
    expect(list.matches("tasks.base")).toBe(false);
    expect(list.matches("Other/Tasks.base")).toBe(false);
    expect(list.matches("Tasks.base.bak")).toBe(false);
  });

  it("treats a trailing slash as a folder prefix on whole segments", () => {
    const list = compileVaultAllowlist(["Projects/"]);
    expect(list.matches("Projects/a.base")).toBe(true);
    expect(list.matches("Projects/deep/er/a.base")).toBe(true);
    expect(list.matches("Projects-evil/a.base")).toBe(false);
    expect(list.matches("Other/Projects/a.base")).toBe(false);
  });

  it("supports * within a segment and ** across segments", () => {
    const list = compileVaultAllowlist(["Bases/*.base", "**/shared.base"]);
    expect(list.matches("Bases/a.base")).toBe(true);
    expect(list.matches("Bases/sub/a.base")).toBe(false);
    expect(list.matches("shared.base")).toBe(true);
    expect(list.matches("x/y/shared.base")).toBe(true);
    expect(list.matches("x/notshared.base")).toBe(false);
  });

  it("escapes regex metacharacters in entries", () => {
    const list = compileVaultAllowlist(["a+b (1).base"]);
    expect(list.matches("a+b (1).base")).toBe(true);
    expect(list.matches("aab (1).base")).toBe(false);
  });

  it("does not let traversal strings match a prefix entry", () => {
    const list = compileVaultAllowlist(["Projects/"]);
    // Request validation rejects these before matching; matching alone must not be the only line of defense,
    // but the lexical string "Projects/../Secret.base" does start with the prefix, so assert the validator catches it.
    expect(parseVaultQueryRequest({ base: "Projects/../Secret.base" })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(list.matches("Secret.base")).toBe(false);
  });
});

describe("parseVaultQueryRequest", () => {
  it("applies defaults and clamps limit", () => {
    expect(parseVaultQueryRequest({ base: "A.base" })).toEqual({
      ok: true,
      request: { base: "A.base", view: undefined, limit: VAULT_QUERY_DEFAULT_ROW_LIMIT },
    });
    expect(parseVaultQueryRequest({ base: "A.base", view: "Main", limit: 999_999 })).toEqual({
      ok: true,
      request: { base: "A.base", view: "Main", limit: VAULT_QUERY_MAX_ROW_LIMIT },
    });
  });

  it.each([
    [null], [[]], ["A.base"], [{}], [{ base: 5 }], [{ base: "A.md" }], [{ base: "A.base", view: "" }],
    [{ base: "A.base", limit: 0 }], [{ base: "A.base", limit: 1.5 }], [{ base: "A.base", limit: "5" }],
    [{ base: "A.base", filters: {} }], [{ def: { views: [] } }], [{ base: "/abs/A.base" }],
  ])("rejects %j with bad_request", (input) => {
    expect(parseVaultQueryRequest(input)).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});

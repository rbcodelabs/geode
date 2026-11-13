import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARTIFACT_FEEDBACK_CONTRACT_VERSIONS } from "../../src/artifacts/feedback-contract";
import {
  ARTIFACT_COMMENT_ID_PATTERN,
  ARTIFACT_COMMENTS_CALL_TIMEOUT_MS,
  ARTIFACT_COMMENTS_CAPS,
  ARTIFACT_COMMENTS_REQUEST_ID_PATTERN,
  ARTIFACT_COMMENTS_SEND_TIMEOUT_MS,
  ARTIFACT_FEEDBACK_SUPPORTED_VERSIONS,
  type ArtifactFeedbackHandlerV2,
} from "../../src/artifacts/feedback-contract-v2";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");

describe("v1 contract file is frozen (ADR 0006 Addendum 1, A2.1)", () => {
  // The Design plugin vendors a verbatim copy of this file and hashes it. .gitattributes pins eol=lf so the raw bytes are stable on Windows.
  it("feedback-contract.ts is byte-identical to the version released in v0.30.18", () => {
    const bytes = readFileSync(path.join(root, "src", "artifacts", "feedback-contract.ts"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("4a30e96cc3d2024bafa75fddbc66a2043cc5868e3c5a5f1518a38a1fc351e857");
  });

  it("keeps its v1 constant meaning ('what the v1 file defines')", () => {
    expect([...ARTIFACT_FEEDBACK_CONTRACT_VERSIONS]).toEqual([1]);
  });
});

describe("v2 constants", () => {
  it("matches the design note", () => {
    expect([...ARTIFACT_FEEDBACK_SUPPORTED_VERSIONS]).toEqual([1, 2]);
    expect(ARTIFACT_COMMENTS_CALL_TIMEOUT_MS).toBe(10_000);
    expect(ARTIFACT_COMMENTS_SEND_TIMEOUT_MS).toBe(15_000);
    expect(ARTIFACT_COMMENTS_CAPS).toEqual({
      maxComments: 200, maxBatch: 20, maxTextUnits: 4000, maxLabelUnits: 120, maxNoticeUnits: 300,
      maxMessageUnits: 500, maxSubscribersPerRoot: 8, maxReportAnchors: 100,
    });
  });

  it("id patterns accept the derived forms and reject traversal", () => {
    expect(ARTIFACT_COMMENT_ID_PATTERN.test("cmt_0123456789abcdef0123456789abcdef")).toBe(true);
    expect(ARTIFACT_COMMENT_ID_PATTERN.test("cmt_0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(ARTIFACT_COMMENT_ID_PATTERN.test("cmt_../../x")).toBe(false);
    expect(ARTIFACT_COMMENT_ID_PATTERN.test("cmt_0123456789abcdef0123456789abcdef\n")).toBe(false);
    expect(ARTIFACT_COMMENTS_REQUEST_ID_PATTERN.test("req_00112233445566778899aabbccddeeff")).toBe(true);
    expect(ARTIFACT_COMMENTS_REQUEST_ID_PATTERN.test("req_short")).toBe(false);
  });
});

describe("v2 contract file shape", () => {
  const source = read("src", "artifacts", "feedback-contract-v2.ts");

  it("imports only types from the v1 file (one import, no runtime dependency)", () => {
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(source.match(/^import type \{/gm)).toHaveLength(1);
    expect(source).toMatch(/\} from "\.\/feedback-contract";/);
    expect(imports.every((line) => line.startsWith("import type"))).toBe(true);
  });

  it("a v2 handler is a v1 handler plus contractVersion 2 and a provider (compile-time shape)", () => {
    const handler = {
      contractVersion: 2,
      submit: async () => ({ status: "accepted" as const }),
      comments: {} as ArtifactFeedbackHandlerV2["comments"],
    } satisfies ArtifactFeedbackHandlerV2;
    expect(handler.contractVersion).toBe(2);
  });
});

describe("ADR 0006 Addendum 1", () => {
  const adr = read("docs", "adr", "0006-artifact-element-inspector.md");
  const source = read("src", "artifacts", "feedback-contract-v2.ts");

  it("is appended and embeds the contract types verbatim in A.3", () => {
    expect(adr).toContain("## Addendum 1 (2026-11-12): contract v2, pinned comments (Phase 2b-i)");
    for (const heading of ["### A.1 Context", "### A.2 Decisions", "### A.3 Types", "### A.4 Inspector protocol additions", "### A.5 Pin UI contract", "### A.6 Rejected alternatives", "### A.7 Threat model additions", "### A.8 Consequences", "### A.9 Implementation map"]) {
      expect(adr).toContain(heading);
    }
    const block = source.slice(source.indexOf("import type {")).trimEnd();
    expect(adr).toContain(block);
  });

  it("leaves the pre-existing ADR text untouched above the addendum", () => {
    const head = adr.slice(0, adr.indexOf("## Addendum 1"));
    expect(head.length).toBeGreaterThan(70_000);
    expect(head).toContain("## Implementation notes: Phase 2a review fix pass");
  });
});

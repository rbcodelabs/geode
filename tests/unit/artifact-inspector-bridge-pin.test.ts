import { describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import type { ArtifactCommentsClient } from "../../src/renderer/artifacts/comments-client";
import { ArtifactInspectorBridge, type SelectionSnapshot } from "../../src/renderer/views/artifact-inspector-bridge";
import { comment } from "./helpers/pin-fixtures";

/** Phase 2b-i G3: bridge.pin(snapshot, comment) builds the same v1 request as Send and hands it to comments.save. */

const target: ArtifactFeedbackTarget = { root: "/art", artifactId: "demo", title: "Demo", runtime: "static", vaultRead: false };
const selection = { schemaVersion: 1, selectionId: "sel_" + "1".repeat(32), artifactId: "demo", artifactRevision: 1, viewSessionId: "reg-1", viewportPreset: "fill", route: "/index.html", tag: "button" };
const snap = (over: Record<string, unknown> = {}): SelectionSnapshot =>
  ({ selection: { ...selection, ...over }, screenshot: { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1, cssRect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1, downscaled: false }, screenshotOmitted: null }) as unknown as SelectionSnapshot;

function setup(client: Partial<ArtifactCommentsClient> | null, revision = 1) {
  const bridge = new ArtifactInspectorBridge({
    webview: { send: () => {}, addEventListener: () => {}, removeEventListener: () => {}, capturePage: () => Promise.reject(new Error("unused")) },
    registration: { registrationId: "reg-1", artifactId: "demo" },
    target,
    registry: { submit: vi.fn(async () => ({ status: "accepted" as const, source: "handler" as const })) },
    comments: () => client as ArtifactCommentsClient | null,
    getRevision: () => revision,
    getViewportPreset: () => "fill",
    callbacks: { onHover: () => {}, onSelect: () => {}, onCancel: () => {} },
    now: () => 1_700_000_000_000,
  });
  return bridge;
}
const saved = (ordinal = 3, created = true) => ({ status: "ok" as const, value: { comment: comment(ordinal), created } });

describe("ArtifactInspectorBridge.pin", () => {
  it("saves the v1 request (trimmed comment, selection, screenshot copy) and reports the ordinal", async () => {
    const save = vi.fn().mockResolvedValue(saved(3));
    const bridge = setup({ save });
    const s = snap();
    const outcome = await bridge.pin(s, "  Make it bigger  ");
    expect(outcome).toEqual({ status: "accepted", message: "Pinned as comment 3.", source: "handler" });
    const request = save.mock.calls[0]![0].request;
    expect(request).toMatchObject({ contractVersion: 1, comment: "Make it bigger", artifact: target, stale: false, screenshotOmitted: null });
    expect(request.selection).toBe(s.selection);
    expect(request.screenshot.bytes).not.toBe(s.screenshot!.bytes);
    expect(Object.keys(save.mock.calls[0]![0])).toEqual(["request"]);
  });

  it("a replay that finds the existing pin says so", async () => {
    const bridge = setup({ save: vi.fn().mockResolvedValue(saved(3, false)) });
    expect(await bridge.pin(snap(), "x")).toMatchObject({ status: "accepted", message: "Already pinned as comment 3." });
  });

  it("marks the request stale when the revision moved", async () => {
    const save = vi.fn().mockResolvedValue(saved());
    await setup({ save }, 2).pin(snap(), "x");
    expect(save.mock.calls[0]![0].request.stale).toBe(true);
  });

  it("a retry with the same snapshot reuses the same selection id", async () => {
    const save = vi.fn().mockResolvedValue({ status: "rejected", reason: "failed", message: "no" });
    const bridge = setup({ save });
    const s = snap();
    await bridge.pin(s, "x");
    await bridge.pin(s, "x");
    expect(save.mock.calls[0]![0].request.selection.selectionId).toBe(save.mock.calls[1]![0].request.selection.selectionId);
  });

  it.each([
    ["busy", "busy"], ["invalid", "invalid"], ["limit", "invalid"], ["conflict", "failed"], ["unavailable", "unavailable"],
    ["read-only", "unavailable"], ["failed", "failed"], ["foreign", "failed"],
  ])("maps the plugin reason %s to %s and keeps the message", async (reason, expected) => {
    const bridge = setup({ save: vi.fn().mockResolvedValue({ status: "rejected", reason, message: "plugin said so" }) });
    expect(await bridge.pin(snap(), "x")).toEqual({ status: "rejected", reason: expected, message: "plugin said so", source: "handler" });
  });

  it("rejects without a comments client (v1 handler or none)", async () => {
    const outcome = await setup(null).pin(snap(), "x");
    expect(outcome).toMatchObject({ status: "rejected", reason: "unavailable", source: "no-handler" });
  });

  it("rejects an empty or oversized comment and a foreign preview without calling save", async () => {
    const save = vi.fn();
    const bridge = setup({ save });
    expect(await bridge.pin(snap(), "   ")).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(await bridge.pin(snap(), "x".repeat(4001))).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(await bridge.pin(snap({ viewSessionId: "other" }), "x")).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(save).not.toHaveBeenCalled();
  });

  it("never throws when save throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = setup({ save: vi.fn(() => { throw new Error("boom"); }) });
    expect(await bridge.pin(snap(), "x")).toMatchObject({ status: "rejected", reason: "failed" });
    warn.mockRestore();
  });

  it("send (v1 submit) is unchanged", async () => {
    const bridge = setup(null);
    expect(await bridge.submit(snap(), "hello")).toMatchObject({ status: "accepted" });
  });
});

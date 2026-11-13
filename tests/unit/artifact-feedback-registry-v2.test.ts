import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackHandler, ArtifactFeedbackRequest, ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import type { ArtifactFeedbackHandlerV2 } from "../../src/artifacts/feedback-contract-v2";
import { ArtifactFeedbackService, createReadOnlyFeedbackView } from "../../src/renderer/artifacts/feedback-registry";
import { Plugin } from "../../src/renderer/plugin";

const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const request = { contractVersion: 1, artifact: target, comment: "c" } as unknown as ArtifactFeedbackRequest;
const owner = (id: string) => ({ pluginId: id, displayName: id.toUpperCase() });

const provider = (over: Record<string, unknown> = {}) => ({
  capabilities: { pins: true, batchSend: true, textEdit: false },
  list: vi.fn(), get: vi.fn(), save: vi.fn(), update: vi.fn(), remove: vi.fn(), adopt: vi.fn(),
  subscribe: vi.fn(() => ({ dispose() {} })), sendBatch: vi.fn(),
  ...over,
});
const v1 = (): ArtifactFeedbackHandler => ({ contractVersion: 1, submit: vi.fn(async () => ({ status: "accepted" as const })) });
const v2 = (over: Record<string, unknown> = {}): ArtifactFeedbackHandlerV2 =>
  ({ contractVersion: 2, submit: vi.fn(async () => ({ status: "accepted" as const })), comments: provider(), ...over }) as unknown as ArtifactFeedbackHandlerV2;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe("negotiation matrix (design note 1.1)", () => {
  it("advertises [1, 2], frozen, through the read-only plugin view", () => {
    const svc = new ArtifactFeedbackService();
    expect([...svc.contractVersions]).toEqual([1, 2]);
    const view = createReadOnlyFeedbackView(svc);
    expect([...view.contractVersions]).toEqual([1, 2]);
    expect(Object.isFrozen(view.contractVersions)).toBe(true);
    expect(Object.keys(view).sort()).toEqual(["contractVersions", "has", "onDidChange"]);
  });

  it("accepts a v1 handler and a v2 handler", () => {
    expect(new ArtifactFeedbackService().register(owner("a"), v1()).status).toBe("registered");
    expect(new ArtifactFeedbackService().register(owner("a"), v2()).status).toBe("registered");
  });

  it("rejects versions outside [1, 2] as unsupported-version", () => {
    const svc = new ArtifactFeedbackService();
    for (const contractVersion of [0, 3, 2.5, "2", null, undefined, Number.NaN]) {
      const result = svc.register(owner("a"), { contractVersion, submit: async () => ({ status: "accepted" }), comments: provider() } as never);
      expect(result.status, String(contractVersion)).toBe("unsupported-version");
    }
  });

  it("a v2 handler without a usable provider is invalid, not silently downgraded", () => {
    const svc = new ArtifactFeedbackService();
    expect(svc.register(owner("a"), v2({ comments: undefined })).status).toBe("invalid");
    expect(svc.register(owner("a"), v2({ comments: "nope" })).status).toBe("invalid");
    expect(svc.register(owner("a"), v2({ comments: provider({ list: undefined }) })).status).toBe("invalid");
    expect(svc.register(owner("a"), v2({ comments: provider({ sendBatch: "x" }) })).status).toBe("invalid");
    expect(svc.register(owner("a"), v2({ comments: provider({ capabilities: undefined }) })).status).toBe("invalid");
    expect(svc.register(owner("a"), v2({ comments: provider({ capabilities: { pins: false, batchSend: true, textEdit: false } }) })).status).toBe("invalid");
    expect(svc.register(owner("a"), v2({ comments: provider({ capabilities: { pins: true, batchSend: true, textEdit: "yes" } }) })).status).toBe("invalid");
    expect(svc.register(owner("a"), v2({ submit: undefined })).status).toBe("invalid");
    expect(svc.has(target)).toBe(false);
  });

  it("v1 handler: no comments client, Send routes as before", async () => {
    const svc = new ArtifactFeedbackService();
    const handler = v1();
    svc.register(owner("a"), handler);
    expect(svc.has(target)).toBe(true);
    expect(svc.commentsFor(target)).toBeNull();
    expect(await svc.submit(target, request)).toMatchObject({ status: "accepted", source: "handler" });
    expect(handler.submit).toHaveBeenCalledTimes(1);
  });

  it("v2 handler: Send still goes through v1 submit exactly as before", async () => {
    const svc = new ArtifactFeedbackService();
    const handler = v2();
    svc.register(owner("a"), handler);
    expect(svc.commentsFor(target)).not.toBeNull();
    expect(await svc.submit(target, request)).toMatchObject({ status: "accepted", source: "handler" });
    expect(handler.submit).toHaveBeenCalledTimes(1);
  });

  it("both versions registered by two plugins: first match wins, no fall-through, Pin only when the routed handler is v2", () => {
    const first = new ArtifactFeedbackService();
    first.register(owner("a"), v2());
    first.register(owner("b"), v1());
    expect(first.commentsFor(target)).not.toBeNull();
    expect(first.describeRoute(target)).toEqual({ displayName: "A", contractVersion: 2 });
    const second = new ArtifactFeedbackService();
    second.register(owner("a"), v1());
    second.register(owner("b"), v2());
    expect(second.commentsFor(target)).toBeNull();
    expect(second.describeRoute(target)).toEqual({ displayName: "A", contractVersion: 1 });
  });

  it("describeRoute is null when nothing handles the target and never throws on a throwing canHandle", () => {
    const svc = new ArtifactFeedbackService();
    expect(svc.describeRoute(target)).toBeNull();
    svc.register(owner("a"), v2({ canHandle: () => { throw new Error("x"); } }));
    expect(svc.describeRoute(target)).toBeNull();
    expect(svc.commentsFor(target)).toBeNull();
  });

  it("registration of a v2 handler notifies listeners and dispose frees the owner slot", () => {
    const svc = new ArtifactFeedbackService();
    const changes = vi.fn();
    svc.onDidChange(changes);
    const reg = svc.register(owner("a"), v2());
    expect(changes).toHaveBeenCalledTimes(1);
    reg.dispose();
    expect(changes).toHaveBeenCalledTimes(2);
    expect(svc.register(owner("a"), v1()).status).toBe("registered");
  });
});

class TestPlugin extends Plugin { onload() {} }
const manifest = (id: string, name: string) => ({ id, name, version: "1", minAppVersion: "0" }) as never;
const makePlugin = (service: ArtifactFeedbackService, id = "design", name = "Design") =>
  new TestPlugin({ artifactFeedback: createReadOnlyFeedbackView(service), artifactFeedbackService: service } as never, manifest(id, name));

describe("Plugin.registerArtifactFeedbackHandler accepts v2", () => {
  it("registers a v2 handler under the manifest identity and disposes it on unload", async () => {
    const svc = new ArtifactFeedbackService();
    const plugin = makePlugin(svc);
    const reg = plugin.registerArtifactFeedbackHandler(v2());
    expect(reg.status).toBe("registered");
    expect(svc.describeRoute(target)).toEqual({ displayName: "Design", contractVersion: 2 });
    await plugin.unloadAndWait();
    expect(svc.has(target)).toBe(false);
    expect(svc.commentsFor(target)).toBeNull();
  });

  it("a plugin that negotiates down registers the same handler as v1 and gets no comments client", () => {
    const svc = new ArtifactFeedbackService();
    const plugin = makePlugin(svc);
    const handler = v2();
    const asV1: ArtifactFeedbackHandler = { contractVersion: 1, submit: handler.submit };
    expect(plugin.registerArtifactFeedbackHandler(asV1).status).toBe("registered");
    expect(svc.commentsFor(target)).toBeNull();
  });

  it("reports unsupported-version for version 3 instead of throwing", () => {
    const plugin = makePlugin(new ArtifactFeedbackService());
    expect(plugin.registerArtifactFeedbackHandler({ contractVersion: 3, submit: async () => ({ status: "accepted" }) } as never).status).toBe("unsupported-version");
  });
});

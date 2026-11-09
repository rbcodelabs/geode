import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackHandler, ArtifactFeedbackRequest, ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import { ArtifactFeedbackService } from "../../src/renderer/artifacts/feedback-registry";
import { Plugin } from "../../src/renderer/plugin";

const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const request = { contractVersion: 1, artifact: target, comment: "c" } as unknown as ArtifactFeedbackRequest;

class TestPlugin extends Plugin { onload() {} }
const manifest = (id: string, name: string) => ({ id, name, version: "1", minAppVersion: "0" }) as never;
const makePlugin = (artifactFeedback: unknown, id = "design", name = "Design") =>
  new TestPlugin({ artifactFeedback } as never, manifest(id, name));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe("Plugin.registerArtifactFeedbackHandler", () => {
  it("registers under an owner derived from the manifest, not from the handler", async () => {
    const svc = new ArtifactFeedbackService();
    const plugin = makePlugin(svc, "design", "Threads Design");
    const handler: ArtifactFeedbackHandler = { contractVersion: 1, submit: async () => ({ status: "accepted" }), ...( { pluginId: "evil", displayName: "evil" } as object) };
    const reg = plugin.registerArtifactFeedbackHandler(handler);
    expect(reg.status).toBe("registered");
    expect(svc.has(target)).toBe(true);
    // a second plugin cannot claim the same id through the handler; conflict is keyed by manifest id
    expect(makePlugin(svc, "design", "Other").registerArtifactFeedbackHandler(handler).status).toBe("conflict");
    expect(makePlugin(svc, "evil", "Evil").registerArtifactFeedbackHandler(handler).status).toBe("registered");
  });

  it("is disposed on plugin unload: handler removed, in-flight submit settles as unavailable with the display name", async () => {
    const svc = new ArtifactFeedbackService();
    const plugin = makePlugin(svc, "design", "Threads Design");
    let signal!: AbortSignal;
    plugin.registerArtifactFeedbackHandler({ contractVersion: 1, submit: (_r, ctx) => { signal = ctx.signal; return new Promise(() => {}); } });
    const pending = svc.submit(target, request);
    await plugin.unloadAndWait();
    expect(await pending).toMatchObject({ status: "rejected", reason: "unavailable", message: "Threads Design is no longer available.", source: "disposed" });
    expect(signal.aborted).toBe(true);
    expect(svc.has(target)).toBe(false);
  });

  it("a throwing handler never reaches the plugin error boundary", async () => {
    const svc = new ArtifactFeedbackService();
    const plugin = makePlugin(svc);
    const errorHandler = vi.fn();
    plugin.setErrorHandler(errorHandler);
    plugin.registerArtifactFeedbackHandler({ contractVersion: 1, canHandle: () => { throw new Error("c"); }, submit: async () => { throw new Error("s"); } });
    svc.has(target);
    plugin.registerArtifactFeedbackHandler({ contractVersion: 1, submit: async () => { throw new Error("s"); } }); // conflict, ignored
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it("reports unavailable instead of throwing when the host has no registry (older or mobile host)", () => {
    expect(makePlugin(undefined).registerArtifactFeedbackHandler({ contractVersion: 1, submit: async () => ({ status: "accepted" }) }).status).toBe("unavailable");
  });

  it("throws only when the plugin generation is inactive, like every Plugin.register*", async () => {
    const plugin = makePlugin(new ArtifactFeedbackService());
    await plugin.unloadAndWait();
    expect(() => plugin.registerArtifactFeedbackHandler({ contractVersion: 1, submit: async () => ({ status: "accepted" }) })).toThrow(/no longer active/);
  });

  it("feature detection: the registry exposes contractVersions including 1", () => {
    expect(new ArtifactFeedbackService().contractVersions).toContain(1);
    expect(typeof Plugin.prototype.registerArtifactFeedbackHandler).toBe("function");
  });
});

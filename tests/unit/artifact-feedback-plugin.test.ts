import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackHandler, ArtifactFeedbackRequest, ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import { ArtifactFeedbackService, createReadOnlyFeedbackView } from "../../src/renderer/artifacts/feedback-registry";
import { Plugin } from "../../src/renderer/plugin";

const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const request = { contractVersion: 1, artifact: target, comment: "c" } as unknown as ArtifactFeedbackRequest;

class TestPlugin extends Plugin { onload() {} }
const manifest = (id: string, name: string) => ({ id, name, version: "1", minAppVersion: "0" }) as never;
/** Mirrors App: the service on an internal reference, plugins see only the read-only view. */
const makePlugin = (service: ArtifactFeedbackService | undefined, id = "design", name = "Design") =>
  new TestPlugin({ artifactFeedback: service ? createReadOnlyFeedbackView(service) : undefined, artifactFeedbackService: service } as never, manifest(id, name));

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
    expect(await pending).toMatchObject({ status: "rejected", reason: "unavailable", message: "Threads Design was unloaded before it answered. Check the thread to see whether your comment arrived.", source: "disposed" });
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

describe("what a plugin can reach through app.artifactFeedback (review A7)", () => {
  it("cannot register under another identity or submit through the public view", () => {
    const svc = new ArtifactFeedbackService();
    const plugin = makePlugin(svc);
    const view = (plugin.app as unknown as { artifactFeedback: Record<string, unknown> }).artifactFeedback;
    expect(view.register).toBeUndefined();
    expect(view.submit).toBeUndefined();
    expect(typeof view.has).toBe("function");
    expect(svc.has(target)).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactCanvasLodPool,
  type ArtboardDescriptor,
  type ArtifactLodHost,
  type ArtifactLodRegistration,
  type ArtifactLodWebview,
} from "../../src/renderer/canvas/artifact-lod-pool";

function makeArtboard(nodeId: string, root: string, entry?: string): ArtboardDescriptor {
  const wrapperEl = document.createElement("div");
  const titleEl = document.createElement("span");
  const stageEl = document.createElement("div");
  const interactBtn = document.createElement("button");
  wrapperEl.append(titleEl, interactBtn, stageEl);
  document.body.appendChild(wrapperEl);
  return {
    nodeId,
    root,
    entry,
    width: 1440,
    height: 900,
    titleEl,
    stageEl,
    wrapperEl,
    interactBtn,
    isAlive: () => wrapperEl.isConnected,
  };
}

function createFakeHost() {
  let regSeq = 0;
  let blobSeq = 0;
  const revisions = new Map<string, number>();
  const registerCalls: string[] = [];
  const unregisterCalls: string[] = [];
  const captureCalls: Array<{ root: string; entry?: string; width: number; height: number }> = [];
  const createdBlobs: string[] = [];
  const revokedBlobs: string[] = [];
  const reloadCounts = new Map<HTMLElement, number>();
  const registrations = new Map<string, ArtifactLodRegistration>();

  const host: ArtifactLodHost = {
    async registerArtifact(root) {
      registerCalls.push(root);
      const id = `reg-${++regSeq}`;
      const artifactId = root.split("/").pop() || `art-${regSeq}`;
      const registration: ArtifactLodRegistration = {
        registrationId: id,
        artifactId,
        title: `Title ${artifactId}`,
        entryUrl: `geode-artifact://${artifactId}/index.html`,
        partition: `geode-artifact-${id}`,
        runtime: "static",
      };
      registrations.set(id, registration);
      revisions.set(id, 0);
      return { ok: true, registration };
    },
    async unregisterArtifact(registrationId) {
      unregisterCalls.push(registrationId);
      registrations.delete(registrationId);
      return true;
    },
    async getArtifactState(registrationId) {
      const rev = revisions.get(registrationId);
      return rev === undefined ? null : { revision: rev };
    },
    async captureThumbnail(root, options) {
      captureCalls.push({ root, ...options });
      return {
        png: new Uint8Array([137, 80, 78, 71]),
        width: options.width,
        height: options.height,
        title: `Title ${root.split("/").pop()}`,
        entry: options.entry ?? "index.html",
      };
    },
    createWebview() {
      const el = document.createElement("div") as unknown as ArtifactLodWebview;
      let currentSrc = "";
      Object.defineProperty(el, "src", {
        get: () => currentSrc,
        set: (value: string) => {
          currentSrc = value;
          el.setAttribute("src", value);
        },
      });
      el.reload = () => {
        reloadCounts.set(el, (reloadCounts.get(el) ?? 0) + 1);
      };
      return el;
    },
    createObjectUrl() {
      const url = `blob:fake-${++blobSeq}`;
      createdBlobs.push(url);
      return url;
    },
    revokeObjectUrl(url) {
      revokedBlobs.push(url);
    },
  };

  return {
    host,
    revisions,
    registerCalls,
    unregisterCalls,
    captureCalls,
    createdBlobs,
    revokedBlobs,
    reloadCounts,
    registrations,
  };
}

describe("ArtifactCanvasLodPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("shares one ArtifactRuntime session per root and enforces LRU cap of 4 live webviews", async () => {
    const fake = createFakeHost();
    const pool = new ArtifactCanvasLodPool(fake.host, { maxLiveWebviews: 4 });

    const boards = [
      makeArtboard("ab-1", "/vault/shared", "screens/a.html"),
      makeArtboard("ab-2", "/vault/shared", "screens/b.html"),
      makeArtboard("ab-3", "/vault/shared", "screens/c.html"),
      makeArtboard("ab-4", "/vault/shared", "screens/d.html"),
      makeArtboard("ab-5", "/vault/shared", "screens/e.html"),
      makeArtboard("ab-6", "/vault/other"),
    ];
    for (const board of boards) pool.registerArtboard(board);
    await Promise.resolve();
    await Promise.resolve();

    // Only 2 shared sessions registered (one for /vault/shared, one for /vault/other).
    expect(fake.registerCalls).toEqual(["/vault/shared", "/vault/other"]);
    expect(pool.liveNodeIds).toEqual([]);

    // Promote 4 artboards: all 4 stay live and share partition for /vault/shared.
    for (const id of ["ab-1", "ab-2", "ab-3", "ab-4"]) {
      expect(await pool.enterInteract(id)).toBe(true);
    }
    expect(pool.liveNodeIds).toEqual(["ab-1", "ab-2", "ab-3", "ab-4"]);
    const partitions = boards.slice(0, 4).map((b) => b.stageEl.firstElementChild?.getAttribute("partition"));
    expect(new Set(partitions).size).toBe(1);

    // Touch ab-1 so it becomes MRU; activating ab-5 should evict ab-2 back to Tier 1 PNG.
    await pool.enterInteract("ab-1");
    await pool.enterInteract("ab-5");
    expect(pool.liveNodeIds).toEqual(["ab-3", "ab-4", "ab-1", "ab-5"]);
    expect(boards[1].wrapperEl.dataset.lodTier).toBe("1");
    expect(boards[1].stageEl.querySelector("img.canvas-artboard-image")).not.toBeNull();
    expect(boards[4].wrapperEl.dataset.lodTier).toBe("2");
    expect(boards[4].wrapperEl.classList.contains("is-interacting")).toBe(true);
    expect(boards[0].wrapperEl.classList.contains("is-interacting")).toBe(false);

    // Toggle interact off keeps webview warm in LRU pool but clears .is-interacting.
    expect(await pool.toggleInteract("ab-5")).toBe(false);
    expect(pool.interactingNodeId).toBeNull();
    expect(boards[4].wrapperEl.classList.contains("is-interacting")).toBe(false);
    expect(pool.liveNodeIds).toContain("ab-5");

    await pool.dispose();
    expect(fake.unregisterCalls.sort()).toEqual(["reg-1", "reg-2"]);
    expect(fake.revokedBlobs.length).toBe(fake.createdBlobs.length);
  });

  it("reloads live webviews immediately and debounces Tier 1 snapshot re-captures on revision bumps", async () => {
    const fake = createFakeHost();
    const pool = new ArtifactCanvasLodPool(fake.host, { maxLiveWebviews: 4, pollIntervalMs: 400, recaptureDebounceMs: 400 });

    const liveBoard = makeArtboard("ab-live", "/vault/shared", "screens/live.html");
    const snapBoard = makeArtboard("ab-snap", "/vault/shared", "screens/snap.html");
    pool.registerArtboard(liveBoard);
    pool.registerArtboard(snapBoard);
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.captureCalls.length).toBe(2);
    const initialSnapUrl = snapBoard.stageEl.querySelector<HTMLImageElement>("img")?.src;
    expect(initialSnapUrl).toBe("blob:fake-2");

    await pool.enterInteract("ab-live");
    const liveWebview = liveBoard.stageEl.firstElementChild!;

    // Bump revision twice rapidly: live webview reloads twice, Tier 1 re-capture debounces into 1 call.
    fake.revisions.set("reg-1", 1);
    await pool.pollNow();
    expect(fake.reloadCounts.get(liveWebview)).toBe(1);
    expect(fake.captureCalls.length).toBe(2); // still debouncing

    vi.advanceTimersByTime(200);
    fake.revisions.set("reg-1", 2);
    await pool.pollNow();
    expect(fake.reloadCounts.get(liveWebview)).toBe(2);
    expect(fake.captureCalls.length).toBe(2); // debounce reset

    await vi.advanceTimersByTimeAsync(450);
    expect(fake.captureCalls.length).toBe(3);
    expect(fake.captureCalls[2].entry).toBe("screens/snap.html");
    expect(fake.revokedBlobs).toContain("blob:fake-2");
    expect(snapBoard.stageEl.querySelector<HTMLImageElement>("img")?.src).toBe("blob:fake-3");

    await pool.dispose();
  });

  it("unregisters shared session only when the last node for that root is removed or on dispose", async () => {
    const fake = createFakeHost();
    const pool = new ArtifactCanvasLodPool(fake.host);

    const a = makeArtboard("a", "/vault/shared", "screens/a.html");
    const b = makeArtboard("b", "/vault/shared", "screens/b.html");
    pool.registerArtboard(a);
    pool.registerArtboard(b);
    await Promise.resolve();
    await Promise.resolve();

    pool.removeNode("a");
    expect(fake.unregisterCalls).toEqual([]);
    expect(pool.registeredSessionRoots).toEqual(["/vault/shared"]);

    pool.removeNode("b");
    expect(fake.unregisterCalls).toEqual(["reg-1"]);
    expect(pool.registeredSessionRoots).toEqual([]);
    expect(fake.revokedBlobs.length).toBe(fake.createdBlobs.length);
  });
});

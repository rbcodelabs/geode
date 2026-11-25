export interface ArtifactLodWebview extends HTMLElement {
  src: string;
  reload(): void;
}

export interface ArtifactLodRegistration {
  registrationId: string;
  artifactId: string;
  title: string;
  entryUrl: string;
  partition: string;
  runtime: string;
}

export interface ArtifactLodHost {
  registerArtifact(root: string): Promise<
    | { ok: true; registration: ArtifactLodRegistration }
    | { ok: false; error: { message: string } }
  >;
  unregisterArtifact(registrationId: string): Promise<boolean>;
  getArtifactState(registrationId: string): Promise<{ revision: number } | null>;
  captureThumbnail(
    root: string,
    options: { entry?: string; width: number; height: number },
  ): Promise<{ png: Uint8Array; width: number; height: number; title: string; entry: string }>;
  createWebview(): ArtifactLodWebview;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

export interface ArtboardDescriptor {
  nodeId: string;
  root: string;
  entry?: string;
  width: number;
  height: number;
  titleEl: HTMLElement;
  stageEl: HTMLElement;
  wrapperEl: HTMLElement;
  interactBtn: HTMLButtonElement;
  isAlive(): boolean;
}

export interface ArtifactCanvasLodPoolOptions {
  maxLiveWebviews?: number;
  pollIntervalMs?: number;
  recaptureDebounceMs?: number;
}

interface RootSession {
  root: string;
  nodeIds: Set<string>;
  registration: ArtifactLodRegistration | null;
  pending: Promise<ArtifactLodRegistration | null> | null;
  lastRevision: number;
  retired: boolean;
}

interface ManagedArtboard extends ArtboardDescriptor {
  blobUrl: string | null;
  thumbnailImg: HTMLImageElement | null;
  webview: ArtifactLodWebview | null;
  captureGeneration: number;
  recaptureTimer: ReturnType<typeof setTimeout> | null;
  snapshotStale: boolean;
}

export const DEFAULT_MAX_LIVE_WEBVIEWS = 4;
export const DEFAULT_POLL_INTERVAL_MS = 400;
export const DEFAULT_RECAPTURE_DEBOUNCE_MS = 400;

function resolveSessionEntryUrl(registration: ArtifactLodRegistration, entry?: string): string {
  if (!entry) return registration.entryUrl;
  const clean = entry.replace(/^#/, "").trim();
  if (!clean) return registration.entryUrl;
  const encoded = clean.split("/").map(encodeURIComponent).join("/");
  return `geode-artifact://${registration.artifactId}/${encoded}`;
}

export class ArtifactCanvasLodPool {
  readonly maxLiveWebviews: number;
  private readonly pollIntervalMs: number;
  private readonly recaptureDebounceMs: number;
  private readonly artboards = new Map<string, ManagedArtboard>();
  private readonly sessions = new Map<string, RootSession>();
  private readonly liveOrder: string[] = [];
  private interactingId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private generation = 0;

  constructor(
    private readonly host: ArtifactLodHost,
    options: ArtifactCanvasLodPoolOptions = {},
  ) {
    this.maxLiveWebviews = Math.max(1, options.maxLiveWebviews ?? DEFAULT_MAX_LIVE_WEBVIEWS);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.recaptureDebounceMs = options.recaptureDebounceMs ?? DEFAULT_RECAPTURE_DEBOUNCE_MS;
  }

  get interactingNodeId(): string | null {
    return this.interactingId;
  }

  get liveNodeIds(): readonly string[] {
    return [...this.liveOrder];
  }

  get registeredSessionRoots(): readonly string[] {
    return [...this.sessions.keys()];
  }

  registerArtboard(descriptor: ArtboardDescriptor): void {
    // If re-registering an existing nodeId, clean up the old entry first.
    if (this.artboards.has(descriptor.nodeId)) {
      this.removeNode(descriptor.nodeId);
    }
    const managed: ManagedArtboard = {
      ...descriptor,
      blobUrl: null,
      thumbnailImg: null,
      webview: null,
      captureGeneration: 0,
      recaptureTimer: null,
      snapshotStale: false,
    };
    managed.wrapperEl.dataset.lodTier = "1";
    this.artboards.set(descriptor.nodeId, managed);
    this.acquireRootSession(descriptor.root, descriptor.nodeId);
    void this.captureArtboard(managed);
  }

  updateNodeSize(nodeId: string, width: number, height: number): void {
    const artboard = this.artboards.get(nodeId);
    if (!artboard) return;
    artboard.width = width;
    artboard.height = height;
  }

  async toggleInteract(nodeId: string): Promise<boolean> {
    if (this.interactingId === nodeId) {
      this.exitInteract();
      return false;
    }
    return this.enterInteract(nodeId);
  }

  async enterInteract(nodeId: string): Promise<boolean> {
    const artboard = this.artboards.get(nodeId);
    if (!artboard || !artboard.isAlive()) return false;
    if (this.interactingId && this.interactingId !== nodeId) {
      this.clearInteractState(this.interactingId);
    }
    const promoted = await this.promoteToLive(artboard);
    if (!promoted || this.artboards.get(nodeId) !== artboard || !artboard.isAlive()) return false;
    this.interactingId = nodeId;
    artboard.wrapperEl.classList.add("is-interacting");
    artboard.interactBtn.classList.add("is-active");
    artboard.interactBtn.setAttribute("aria-pressed", "true");
    return true;
  }

  exitInteract(): void {
    if (!this.interactingId) return;
    this.clearInteractState(this.interactingId);
    this.interactingId = null;
  }

  private clearInteractState(nodeId: string): void {
    const artboard = this.artboards.get(nodeId);
    if (!artboard) return;
    artboard.wrapperEl.classList.remove("is-interacting");
    artboard.interactBtn.classList.remove("is-active");
    artboard.interactBtn.setAttribute("aria-pressed", "false");
  }

  private async promoteToLive(artboard: ManagedArtboard): Promise<boolean> {
    const gen = this.generation;
    const session = this.sessions.get(artboard.root);
    if (!session) return false;
    const registration = session.registration ?? (await session.pending);
    if (!registration || gen !== this.generation || this.artboards.get(artboard.nodeId) !== artboard || !artboard.isAlive()) {
      return false;
    }

    const existingIdx = this.liveOrder.indexOf(artboard.nodeId);
    if (existingIdx !== -1 && artboard.webview) {
      // Touch MRU position.
      this.liveOrder.splice(existingIdx, 1);
      this.liveOrder.push(artboard.nodeId);
      return true;
    }

    while (this.liveOrder.length >= this.maxLiveWebviews) {
      const evictedId = this.liveOrder.shift();
      if (!evictedId) break;
      const evicted = this.artboards.get(evictedId);
      if (evicted) this.demoteToSnapshot(evicted);
    }

    const webview = this.host.createWebview();
    webview.className = "canvas-artboard-webview";
    webview.setAttribute("partition", registration.partition);
    webview.setAttribute("aria-label", registration.title || artboard.titleEl.textContent || "Design artboard");
    webview.src = resolveSessionEntryUrl(registration, artboard.entry);
    artboard.webview = webview;
    artboard.wrapperEl.dataset.lodTier = "2";
    artboard.stageEl.replaceChildren(webview);
    this.liveOrder.push(artboard.nodeId);
    return true;
  }

  private demoteToSnapshot(artboard: ManagedArtboard): void {
    if (this.interactingId === artboard.nodeId) {
      this.clearInteractState(artboard.nodeId);
      this.interactingId = null;
    }
    const idx = this.liveOrder.indexOf(artboard.nodeId);
    if (idx !== -1) this.liveOrder.splice(idx, 1);
    if (artboard.webview) {
      artboard.webview.remove();
      artboard.webview = null;
    }
    artboard.wrapperEl.dataset.lodTier = "1";
    if (artboard.thumbnailImg) {
      artboard.stageEl.replaceChildren(artboard.thumbnailImg);
    } else {
      const status = document.createElement("div");
      status.className = "canvas-artboard-status";
      status.textContent = "Rendering artboard…";
      artboard.stageEl.replaceChildren(status);
    }
    if (artboard.snapshotStale || !artboard.thumbnailImg) {
      artboard.snapshotStale = false;
      this.scheduleRecapture(artboard);
    }
  }

  removeNode(nodeId: string): void {
    const artboard = this.artboards.get(nodeId);
    if (!artboard) return;
    if (this.interactingId === nodeId) {
      this.clearInteractState(nodeId);
      this.interactingId = null;
    }
    if (artboard.recaptureTimer !== null) {
      clearTimeout(artboard.recaptureTimer);
      artboard.recaptureTimer = null;
    }
    const idx = this.liveOrder.indexOf(nodeId);
    if (idx !== -1) this.liveOrder.splice(idx, 1);
    if (artboard.webview) {
      artboard.webview.remove();
      artboard.webview = null;
    }
    if (artboard.blobUrl) {
      this.host.revokeObjectUrl(artboard.blobUrl);
      artboard.blobUrl = null;
    }
    artboard.thumbnailImg = null;
    this.artboards.delete(nodeId);
    this.releaseRootSession(artboard.root, nodeId);
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.stopPolling();
    this.exitInteract();
    for (const artboard of this.artboards.values()) {
      if (artboard.recaptureTimer !== null) {
        clearTimeout(artboard.recaptureTimer);
        artboard.recaptureTimer = null;
      }
      if (artboard.webview) {
        artboard.webview.remove();
        artboard.webview = null;
      }
      if (artboard.blobUrl) {
        this.host.revokeObjectUrl(artboard.blobUrl);
        artboard.blobUrl = null;
      }
      artboard.thumbnailImg = null;
    }
    this.artboards.clear();
    this.liveOrder.length = 0;

    const toUnregister: string[] = [];
    for (const session of this.sessions.values()) {
      session.retired = true;
      session.nodeIds.clear();
      if (session.registration) {
        toUnregister.push(session.registration.registrationId);
        session.registration = null;
      }
    }
    this.sessions.clear();
    await Promise.allSettled(toUnregister.map((id) => this.host.unregisterArtifact(id)));
  }

  private acquireRootSession(root: string, nodeId: string): void {
    let session = this.sessions.get(root);
    if (session) {
      session.nodeIds.add(nodeId);
      return;
    }
    const gen = this.generation;
    session = {
      root,
      nodeIds: new Set([nodeId]),
      registration: null,
      pending: null,
      lastRevision: 0,
      retired: false,
    };
    this.sessions.set(root, session);
    const created = session;
    created.pending = this.host
      .registerArtifact(root)
      .then(async (result) => {
        if (!result.ok) return null;
        if (created.retired || gen !== this.generation || this.sessions.get(root) !== created) {
          await this.host.unregisterArtifact(result.registration.registrationId).catch(() => {});
          return null;
        }
        created.registration = result.registration;
        this.ensurePolling();
        return result.registration;
      })
      .catch(() => null);
  }

  private releaseRootSession(root: string, nodeId: string): void {
    const session = this.sessions.get(root);
    if (!session) return;
    session.nodeIds.delete(nodeId);
    if (session.nodeIds.size > 0) return;
    session.retired = true;
    this.sessions.delete(root);
    const registrationId = session.registration?.registrationId;
    session.registration = null;
    if (registrationId) {
      void this.host.unregisterArtifact(registrationId).catch(() => {});
    }
    if (this.sessions.size === 0) this.stopPolling();
  }

  private ensurePolling(): void {
    if (this.pollTimer !== null || this.sessions.size === 0) return;
    this.pollTimer = setInterval(() => {
      void this.pollNow();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Exposed for deterministic unit tests; called on the poll timer in production. */
  async pollNow(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const gen = this.generation;
    try {
      for (const session of [...this.sessions.values()]) {
        if (gen !== this.generation || session.retired || !session.registration) continue;
        let state: { revision: number } | null;
        try {
          state = await this.host.getArtifactState(session.registration.registrationId);
        } catch {
          continue;
        }
        if (gen !== this.generation || session.retired || !state) continue;
        if (state.revision > session.lastRevision) {
          session.lastRevision = state.revision;
          this.handleRootRevision(session.root);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private handleRootRevision(root: string): void {
    for (const artboard of this.artboards.values()) {
      if (artboard.root !== root || !artboard.isAlive()) continue;
      if (artboard.webview) {
        artboard.snapshotStale = true;
        artboard.webview.reload();
      } else {
        this.scheduleRecapture(artboard);
      }
    }
  }

  private scheduleRecapture(artboard: ManagedArtboard): void {
    if (artboard.recaptureTimer !== null) {
      clearTimeout(artboard.recaptureTimer);
    }
    artboard.recaptureTimer = setTimeout(() => {
      artboard.recaptureTimer = null;
      if (this.artboards.get(artboard.nodeId) !== artboard || !artboard.isAlive() || artboard.webview) return;
      void this.captureArtboard(artboard);
    }, this.recaptureDebounceMs);
  }

  private async captureArtboard(artboard: ManagedArtboard): Promise<void> {
    const gen = this.generation;
    const captureGen = ++artboard.captureGeneration;
    let result: { png: Uint8Array; width: number; height: number; title: string; entry: string };
    try {
      result = await this.host.captureThumbnail(artboard.root, {
        entry: artboard.entry,
        width: Math.round(artboard.width),
        height: Math.round(artboard.height),
      });
    } catch (error) {
      if (
        gen !== this.generation ||
        captureGen !== artboard.captureGeneration ||
        this.artboards.get(artboard.nodeId) !== artboard ||
        !artboard.isAlive()
      ) {
        return;
      }
      if (!artboard.webview && !artboard.thumbnailImg) {
        const status = document.createElement("div");
        status.className = "canvas-artboard-status";
        status.textContent = error instanceof Error ? error.message : "Could not render artboard";
        artboard.stageEl.replaceChildren(status);
      }
      return;
    }

    if (
      gen !== this.generation ||
      captureGen !== artboard.captureGeneration ||
      this.artboards.get(artboard.nodeId) !== artboard ||
      !artboard.isAlive()
    ) {
      return;
    }

    if (result.title) artboard.titleEl.textContent = result.title;
    const source = result.png instanceof Uint8Array ? result.png : new Uint8Array(result.png as ArrayBufferLike);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const url = this.host.createObjectUrl(new Blob([bytes], { type: "image/png" }));

    if (
      gen !== this.generation ||
      captureGen !== artboard.captureGeneration ||
      this.artboards.get(artboard.nodeId) !== artboard ||
      !artboard.isAlive()
    ) {
      this.host.revokeObjectUrl(url);
      return;
    }

    const oldUrl = artboard.blobUrl;
    artboard.blobUrl = url;
    artboard.snapshotStale = false;

    const img = document.createElement("img");
    img.className = "canvas-node-file canvas-node-media canvas-artboard-image";
    img.alt = result.title || "Design artboard";
    img.draggable = false;
    img.src = url;
    artboard.thumbnailImg = img;

    if (!artboard.webview) {
      artboard.stageEl.replaceChildren(img);
    }
    if (oldUrl) this.host.revokeObjectUrl(oldUrl);
  }
}

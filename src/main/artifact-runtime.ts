import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Session, WebContents, WebPreferences } from "electron";
import { BrowserWindow, session } from "electron";
import { INSPECT_PROTOCOL_VERSION } from "../artifacts/inspector-protocol";
import { parseArtifactManifestJson, type ArtifactManifest, type ArtifactManifestIssue } from "../artifacts/manifest";
import {
  ARTIFACT_SCHEME,
  isArtifactUrlAllowed,
  nextjsArtifactCsp,
  parseLoopbackDevServerUrl,
} from "../artifacts/security-policy";
import { resolveArtifactEntry } from "./artifact-paths";
import { createArtifactWatcher, type ArtifactWatcher } from "./artifact-watcher";
import { createStaticArtifactHandler } from "./artifact-static-handler";

export const ARTIFACT_MANIFEST_FILENAME = "artifact.json";

export interface ArtifactRegistration {
  registrationId: string;
  artifactId: string;
  title: string;
  entryUrl: string;
  partition: string;
  runtime: ArtifactManifest["runtime"];
  viewport: { preset: "desktop" | "tablet" | "mobile" | "custom" | "fill"; width: number; height: number };
  /**
   * Present only when the validated manifest opted in with
   * `permissions.vault: "read"`. The renderer bridge enforces this allowlist
   * on every guest request; main attaches the guest preload only when set.
   */
  vault?: { access: "read"; allowlist: string[] };
  /**
   * Present iff the host-owned element inspector preload was registered on this
   * artifact's session (static artifacts only, ADR 0006 D5). The Pick button
   * depends on this flag, not on guesswork; a failed registration leaves it
   * absent and the artifact still opens.
   */
  inspector?: { protocol: typeof INSPECT_PROTOCOL_VERSION };
}

export interface ArtifactDiagnostic {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  sourceId?: string;
  line?: number;
  at: number;
}

export interface ArtifactRuntimeState {
  revision: number;
  diagnostics: ArtifactDiagnostic[];
}

export interface ArtifactCaptureResult {
  path: string;
  width: number;
  height: number;
}

export type ArtifactRegistrationResult =
  | { ok: true; registration: ArtifactRegistration }
  | {
      ok: false;
      error: {
        code: ArtifactRegistrationError["code"] | "internal";
        message: string;
        issues?: ArtifactManifestIssue[];
      };
    };

interface ActiveArtifact extends ArtifactRegistration {
  ownerWebContentsId: number;
  root: string;
  artifactSession: Session;
  revision: number;
  diagnostics: ArtifactDiagnostic[];
  /** Static artifacts only; a Next.js dev server does its own HMR. */
  watcher?: ArtifactWatcher;
  /** Next.js artifacts only: the single http origin (and ws twin) the guest may reach. */
  allowedOrigin?: string;
  guest?: WebContents;
  /** Id returned by `registerPreloadScript` for the inspector; unregistered on dispose. */
  inspectorPreloadId?: string;
}

export interface ArtifactRegisterOptions {
  /** Untrusted. Validated here; required for `nextjs` manifests and forbidden for `static`. */
  devServerUrl?: unknown;
}

export interface ArtifactCaptureOptions {
  /** Untrusted. Only used for `nextjs` artifacts when no live guest exists. */
  url?: unknown;
}

const CAPTURE_LOAD_TIMEOUT_MS = 20_000;
const CAPTURE_SETTLE_MS = 600;

function vaultGrant(manifest: ArtifactManifest): Pick<ArtifactRegistration, "vault"> {
  if (manifest.runtime !== "static") return {};
  const { permissions } = manifest;
  if (permissions.vault !== "read" || !permissions.vaultAllowlist?.length) return {};
  return { vault: { access: "read", allowlist: [...permissions.vaultAllowlist] } };
}

function resolveDevServerOrigin(
  manifest: ArtifactManifest,
  devServerUrl: unknown,
): { origin: string; url: string } | null {
  if (manifest.runtime === "static") {
    if (devServerUrl !== undefined && devServerUrl !== null) {
      throw new ArtifactRegistrationError("dev_server_invalid", "A dev server URL is only valid for a nextjs artifact.");
    }
    return null;
  }
  const parsed = parseLoopbackDevServerUrl(devServerUrl);
  if (!parsed.ok) {
    throw new ArtifactRegistrationError(
      "dev_server_invalid",
      devServerUrl === undefined || devServerUrl === null
        ? "A nextjs artifact needs a dev server URL."
        : parsed.reason,
    );
  }
  return parsed;
}

export class ArtifactRegistrationError extends Error {
  constructor(
    public readonly code:
      | "manifest_read"
      | "manifest_invalid"
      | "entry_invalid"
      | "dev_server_invalid"
      | "registration_missing"
      | "capture_failed",
    message: string,
    public readonly issues?: ArtifactManifestIssue[],
  ) {
    super(message);
    this.name = "ArtifactRegistrationError";
  }
}

export function serializeArtifactRegistrationError(error: unknown): ArtifactRegistrationResult & { ok: false } {
  if (error instanceof ArtifactRegistrationError) {
    return { ok: false, error: { code: error.code, message: error.message, issues: error.issues } };
  }
  return { ok: false, error: { code: "internal", message: "Artifact registration failed unexpectedly." } };
}

/** Owns all privileged state and policy for untrusted static artifacts. */
export class ArtifactRuntime {
  constructor(
    private readonly guestPreloadPath: string = path.join(__dirname, "artifact-guest-preload.js"),
    /** Injectable like `guestPreloadPath` so tests can use a fake. */
    private readonly inspectorPreloadPath: string = path.join(__dirname, "artifact-inspector-preload.js"),
  ) {}

  private readonly registrations = new Map<string, ActiveArtifact>();
  private readonly registrationsByPartition = new Map<string, ActiveArtifact>();

  private async readManifest(requestedRoot: string): Promise<{ root: string; manifest: ArtifactManifest }> {
    let root: string;
    let manifestJson: string;
    try {
      root = await fsp.realpath(path.resolve(requestedRoot));
      manifestJson = await fsp.readFile(path.join(root, ARTIFACT_MANIFEST_FILENAME), "utf8");
    } catch (error) {
      throw new ArtifactRegistrationError(
        "manifest_read",
        `Could not read ${ARTIFACT_MANIFEST_FILENAME}: ${(error as Error).message}`,
      );
    }

    const parsed = parseArtifactManifestJson(manifestJson);
    if (!parsed.ok) {
      throw new ArtifactRegistrationError("manifest_invalid", "Artifact manifest is invalid.", parsed.issues);
    }

    try {
      await resolveArtifactEntry(root, parsed.manifest.entry);
    } catch (error) {
      throw new ArtifactRegistrationError("entry_invalid", (error as Error).message);
    }
    return { root, manifest: parsed.manifest };
  }

  async register(owner: WebContents, requestedRoot: string, options: ArtifactRegisterOptions = {}): Promise<ArtifactRegistration> {
    const { root, manifest } = await this.readManifest(requestedRoot);
    const devServer = resolveDevServerOrigin(manifest, options?.devServerUrl);

    const registrationId = randomUUID();
    const partition = `geode-artifact-${registrationId}`;
    const artifactSession = session.fromPartition(partition, { cache: false });
    const active: ActiveArtifact = {
      registrationId,
      artifactId: manifest.id,
      title: manifest.title,
      entryUrl: devServer
        ? devServer.url
        : `${ARTIFACT_SCHEME}://${manifest.id}/${manifest.entry.split("/").map(encodeURIComponent).join("/")}`,
      partition,
      runtime: manifest.runtime,
      viewport: manifest.viewport,
      ...vaultGrant(manifest),
      ownerWebContentsId: owner.id,
      root,
      artifactSession,
      revision: 0,
      diagnostics: [],
      watcher: undefined,
      allowedOrigin: devServer?.origin,
    };

    // Dev servers do their own HMR; static artifacts reload when a watched file changes.
    const watcher = devServer ? undefined : createArtifactWatcher(root, () => { active.revision += 1; });
    active.watcher = watcher;

    try {
      await this.configureSession(artifactSession, {
        artifactId: active.artifactId,
        root,
        allowedOrigin: active.allowedOrigin,
      });
    } catch (error) {
      await watcher?.close();
      throw error;
    }
    // Deliberately here and not in configureSession: that is shared with captureHeadless,
    // whose offscreen session must never get the inspector. Static artifacts only (ADR 0005).
    if (!devServer) this.registerInspectorPreload(active);
    this.registrations.set(registrationId, active);
    this.registrationsByPartition.set(partition, active);
    return {
      registrationId: active.registrationId,
      artifactId: active.artifactId,
      title: active.title,
      entryUrl: active.entryUrl,
      partition: active.partition,
      runtime: active.runtime,
      viewport: active.viewport,
      ...(active.vault ? { vault: active.vault } : {}),
      ...(active.inspectorPreloadId ? { inspector: { protocol: INSPECT_PROTOCOL_VERSION } } : {}),
    };
  }

  /**
   * Session-level frame preload, alongside (never instead of) the vault preload that
   * `webPreferences.preload` may carry. A failure only loses the picker.
   */
  private registerInspectorPreload(active: ActiveArtifact): void {
    try {
      active.inspectorPreloadId = active.artifactSession.registerPreloadScript({
        type: "frame",
        filePath: this.inspectorPreloadPath,
      });
    } catch (error) {
      active.inspectorPreloadId = undefined;
      console.warn(`[artifact] inspector preload registration failed for "${active.artifactId}"; the picker is unavailable`, error);
    }
  }

  private async configureSession(
    target: Session,
    policy: { artifactId: string; root: string; allowedOrigin?: string },
  ): Promise<void> {
    const { artifactId, root, allowedOrigin } = policy;
    target.setPermissionCheckHandler(() => false);
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setDevicePermissionHandler(() => false);
    target.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    target.on("will-download", (event) => event.preventDefault());
    // Authoritative network boundary; CSP below is defense in depth.
    target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const use = details.resourceType === "mainFrame" ? "document" : "subresource";
      callback({ cancel: !isArtifactUrlAllowed(details.url, artifactId, use, allowedOrigin) });
    });
    if (allowedOrigin) {
      const csp = nextjsArtifactCsp(allowedOrigin);
      target.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
        const responseHeaders: Record<string, string[]> = {};
        // Replace rather than append: any CSP the dev server sent must not loosen ours.
        for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
          if (name.toLowerCase() !== "content-security-policy") responseHeaders[name] = value;
        }
        responseHeaders["Content-Security-Policy"] = [csp];
        callback({ responseHeaders });
      });
      return;
    }
    await target.protocol.handle(ARTIFACT_SCHEME, createStaticArtifactHandler(artifactId, root));
  }

  secureWebviewAttachment(
    owner: WebContents,
    webPreferences: WebPreferences,
    params: Record<string, string>,
  ): boolean {
    const active = this.registrationsByPartition.get(params.partition ?? "");
    if (!active || active.ownerWebContentsId !== owner.id) return false;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    // `webPreferences.preload` is the vault bridge slot: set only for artifacts whose validated
    // manifest opted into vault reads (a separate, minimal contextBridge surface, see the Compass
    // "ADR - Artifact vault read bridge"), undefined for every other artifact. It does not mean
    // "no preload at all": static artifacts also carry the host-owned inspector, which is
    // registered on the session (registerPreloadScript) and coexists with this slot (ADR 0006 D5).
    webPreferences.preload = active.vault ? this.guestPreloadPath : undefined;
    return true;
  }

  trackGuest(owner: WebContents, guest: WebContents): boolean {
    const active = [...this.registrations.values()].find((candidate) =>
      candidate.ownerWebContentsId === owner.id && candidate.artifactSession === guest.session);
    if (!active) return false;
    active.guest = guest;
    if (active.allowedOrigin) this.denyOffOriginNavigation(guest, active.allowedOrigin);
    guest.on("console-message", (details) => {
      const detail = details as unknown as {
        level?: "debug" | "info" | "warning" | "error";
        message?: string;
        sourceId?: string;
        lineNumber?: number;
      };
      active.diagnostics.push({
        level: detail.level ?? "info",
        message: String(detail.message ?? "").slice(0, 2_000),
        sourceId: detail.sourceId ? String(detail.sourceId).slice(0, 500) : undefined,
        line: detail.lineNumber,
        at: Date.now(),
      });
      if (active.diagnostics.length > 50) active.diagnostics.splice(0, active.diagnostics.length - 50);
    });
    guest.once("destroyed", () => {
      if (active.guest === guest) active.guest = undefined;
    });
    return true;
  }

  /** Redirects and frame navigations off the dev-server origin are cancelled (the request filter would too). */
  private denyOffOriginNavigation(guest: WebContents, allowedOrigin: string): void {
    const deny = (event: { preventDefault(): void }, url: string): void => {
      if (!isArtifactUrlAllowed(url, "", "document", allowedOrigin)) event.preventDefault();
    };
    guest.on("will-navigate", deny);
    guest.on("will-redirect", deny);
    guest.on("will-frame-navigate", (event) => deny(event, event.url));
  }

  /** True for Next.js artifact guests, which must never open popups or Web Viewer tabs. */
  isNextjsGuest(guest: WebContents): boolean {
    return [...this.registrations.values()].some((candidate) =>
      candidate.allowedOrigin !== undefined && candidate.artifactSession === guest.session);
  }

  getState(owner: WebContents, registrationId: string): ArtifactRuntimeState | null {
    const active = this.registrations.get(registrationId);
    if (!active || active.ownerWebContentsId !== owner.id) return null;
    return { revision: active.revision, diagnostics: [...active.diagnostics] };
  }

  async capture(owner: WebContents, requestedRoot: string, options: ArtifactCaptureOptions = {}): Promise<ArtifactCaptureResult> {
    const root = await fsp.realpath(path.resolve(requestedRoot));
    const active = [...this.registrations.values()].find((candidate) =>
      candidate.ownerWebContentsId === owner.id && candidate.root === root);
    if (active?.guest && !active.guest.isDestroyed()) {
      return this.writeCapture(root, await active.guest.capturePage());
    }
    const url = options?.url;
    if (url === undefined || url === null) {
      if (active?.allowedOrigin) return this.captureHeadless(root, active.artifactId, active.allowedOrigin, active.viewport);
      throw new ArtifactRegistrationError("registration_missing", "Open the artifact preview before capturing it.");
    }
    // A URL means "capture the dev server", which is only valid for a nextjs manifest.
    const { manifest } = await this.readManifest(root);
    const devServer = resolveDevServerOrigin(manifest, url);
    if (!devServer) throw new ArtifactRegistrationError("dev_server_invalid", "A capture URL is only valid for a nextjs artifact.");
    return this.captureHeadless(root, manifest.id, devServer.origin, manifest.viewport);
  }

  private async writeCapture(root: string, image: Electron.NativeImage): Promise<ArtifactCaptureResult> {
    const capturesRoot = path.join(root, "captures");
    await fsp.mkdir(capturesRoot, { recursive: true });
    const capturePath = path.join(capturesRoot, `capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await fsp.writeFile(capturePath, image.toPNG());
    const size = image.getSize();
    return { path: capturePath, width: size.width, height: size.height };
  }

  /**
   * Capture without a visible window: a never-shown offscreen BrowserWindow
   * bound to a throwaway session with exactly the same restrictions as a live
   * guest (origin filter, CSP, denied permissions), no preload, no Node.
   */
  private async captureHeadless(
    root: string,
    artifactId: string,
    allowedOrigin: string,
    viewport: { width: number; height: number },
  ): Promise<ArtifactCaptureResult> {
    const partition = `geode-artifact-capture-${randomUUID()}`;
    const captureSession = session.fromPartition(partition, { cache: false });
    let win: BrowserWindow | undefined;
    try {
      await this.configureSession(captureSession, { artifactId, root, allowedOrigin });
      // A never-shown offscreen window, not an unattached view: a detached
      // WebContentsView has no host to size it, so capturePage() returns 0x0.
      win = new BrowserWindow({
        show: false,
        width: viewport.width,
        height: viewport.height,
        useContentSize: true,
        frame: false,
        skipTaskbar: true,
        webPreferences: {
          session: captureSession,
          offscreen: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      const contents = win.webContents;
      contents.setFrameRate(5);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.denyOffOriginNavigation(contents, allowedOrigin);
      const loaded = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out loading the dev server.")), CAPTURE_LOAD_TIMEOUT_MS);
        contents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
        contents.once("did-fail-load", (_event, _code, description) => {
          clearTimeout(timer);
          reject(new Error(description || "Dev server failed to load."));
        });
      });
      loaded.catch(() => { /* observed below; avoids an unhandled rejection while loadURL is pending */ });
      await contents.loadURL(`${allowedOrigin}/`).catch(() => { /* surfaced through did-fail-load */ });
      await loaded;
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_SETTLE_MS));
      return await this.writeCapture(root, await contents.capturePage());
    } catch (error) {
      if (error instanceof ArtifactRegistrationError) throw error;
      throw new ArtifactRegistrationError("capture_failed", `Capture failed: ${(error as Error).message}`);
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
      await Promise.allSettled([captureSession.clearCache(), captureSession.clearStorageData()]);
    }
  }

  private async dispose(active: ActiveArtifact): Promise<void> {
    if (active.inspectorPreloadId) {
      try { active.artifactSession.unregisterPreloadScript(active.inspectorPreloadId); }
      catch (error) { console.warn(`[artifact] inspector preload unregister failed for "${active.artifactId}"`, error); }
    }
    await active.watcher?.close();
    if (!active.allowedOrigin) active.artifactSession.protocol.unhandle(ARTIFACT_SCHEME);
    await Promise.allSettled([active.artifactSession.clearCache(), active.artifactSession.clearStorageData()]);
  }

  async unregister(owner: WebContents, registrationId: string): Promise<boolean> {
    const active = this.registrations.get(registrationId);
    if (!active || active.ownerWebContentsId !== owner.id) return false;
    this.registrations.delete(registrationId);
    this.registrationsByPartition.delete(active.partition);
    await this.dispose(active);
    return true;
  }

  async unregisterOwner(ownerWebContentsId: number): Promise<void> {
    for (const active of [...this.registrations.values()]) {
      if (active.ownerWebContentsId !== ownerWebContentsId) continue;
      this.registrations.delete(active.registrationId);
      this.registrationsByPartition.delete(active.partition);
      await this.dispose(active);
    }
  }
}

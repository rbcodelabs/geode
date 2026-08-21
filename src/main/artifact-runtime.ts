import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Session, WebContents, WebPreferences } from "electron";
import { session } from "electron";
import chokidar, { type FSWatcher } from "chokidar";
import { parseArtifactManifestJson, type ArtifactManifestIssue } from "../artifacts/manifest";
import { ARTIFACT_SCHEME, isArtifactUrlAllowed, STATIC_ARTIFACT_CSP } from "../artifacts/security-policy";
import { resolveArtifactEntry, resolveArtifactFile } from "./artifact-paths";

export const ARTIFACT_MANIFEST_FILENAME = "artifact.json";

export interface ArtifactRegistration {
  registrationId: string;
  artifactId: string;
  title: string;
  entryUrl: string;
  partition: string;
  viewport: { preset: "desktop" | "tablet" | "mobile" | "custom"; width: number; height: number };
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
  watcher: FSWatcher;
  guest?: WebContents;
}

export class ArtifactRegistrationError extends Error {
  constructor(
    public readonly code: "manifest_read" | "manifest_invalid" | "entry_invalid" | "registration_missing",
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

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function response(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

function artifactPathname(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
    return decoded || null;
  } catch {
    return null;
  }
}

/** Owns all privileged state and policy for untrusted static artifacts. */
export class ArtifactRuntime {
  private readonly registrations = new Map<string, ActiveArtifact>();
  private readonly registrationsByPartition = new Map<string, ActiveArtifact>();

  async register(owner: WebContents, requestedRoot: string): Promise<ArtifactRegistration> {
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

    const registrationId = randomUUID();
    const partition = `geode-artifact-${registrationId}`;
    const artifactSession = session.fromPartition(partition, { cache: false });
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (candidate) => path.relative(root, candidate).split(path.sep)[0] === "captures",
    });
    const active: ActiveArtifact = {
      registrationId,
      artifactId: parsed.manifest.id,
      title: parsed.manifest.title,
      entryUrl: `${ARTIFACT_SCHEME}://${parsed.manifest.id}/${parsed.manifest.entry.split("/").map(encodeURIComponent).join("/")}`,
      partition,
      viewport: parsed.manifest.viewport,
      ownerWebContentsId: owner.id,
      root,
      artifactSession,
      revision: 0,
      diagnostics: [],
      watcher,
    };

    watcher.on("all", () => { active.revision += 1; });

    try {
      await this.configureSession(active);
    } catch (error) {
      await watcher.close();
      throw error;
    }
    this.registrations.set(registrationId, active);
    this.registrationsByPartition.set(partition, active);
    return {
      registrationId: active.registrationId,
      artifactId: active.artifactId,
      title: active.title,
      entryUrl: active.entryUrl,
      partition: active.partition,
      viewport: active.viewport,
    };
  }

  private async configureSession(active: ActiveArtifact): Promise<void> {
    const target = active.artifactSession;
    target.setPermissionCheckHandler(() => false);
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setDevicePermissionHandler(() => false);
    target.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    target.on("will-download", (event) => event.preventDefault());
    target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const use = details.resourceType === "mainFrame" ? "document" : "subresource";
      callback({ cancel: !isArtifactUrlAllowed(details.url, active.artifactId, use) });
    });
    await target.protocol.handle(ARTIFACT_SCHEME, async (request) => {
      if (!isArtifactUrlAllowed(request.url, active.artifactId, "document")) {
        return response(403, "Artifact origin denied.");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return response(405, "Method not allowed.", { allow: "GET, HEAD" });
      }
      const relativePath = artifactPathname(request.url);
      if (!relativePath) return response(404, "Artifact file not found.");
      try {
        const { file: filePath } = await resolveArtifactFile(active.root, relativePath);
        const body = request.method === "HEAD" ? null : await fsp.readFile(filePath);
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
            "content-security-policy": STATIC_ARTIFACT_CSP,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return response(404, "Artifact file not found.");
      }
    });
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
    webPreferences.preload = undefined;
    return true;
  }

  trackGuest(owner: WebContents, guest: WebContents): boolean {
    const active = [...this.registrations.values()].find((candidate) =>
      candidate.ownerWebContentsId === owner.id && candidate.artifactSession === guest.session);
    if (!active) return false;
    active.guest = guest;
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

  getState(owner: WebContents, registrationId: string): ArtifactRuntimeState | null {
    const active = this.registrations.get(registrationId);
    if (!active || active.ownerWebContentsId !== owner.id) return null;
    return { revision: active.revision, diagnostics: [...active.diagnostics] };
  }

  async capture(owner: WebContents, requestedRoot: string): Promise<ArtifactCaptureResult> {
    const root = await fsp.realpath(path.resolve(requestedRoot));
    const active = [...this.registrations.values()].find((candidate) =>
      candidate.ownerWebContentsId === owner.id && candidate.root === root);
    if (!active?.guest || active.guest.isDestroyed()) {
      throw new ArtifactRegistrationError("registration_missing", "Open the artifact preview before capturing it.");
    }
    const image = await active.guest.capturePage();
    const capturesRoot = path.join(active.root, "captures");
    await fsp.mkdir(capturesRoot, { recursive: true });
    const capturePath = path.join(capturesRoot, `capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await fsp.writeFile(capturePath, image.toPNG());
    const size = image.getSize();
    return { path: capturePath, width: size.width, height: size.height };
  }

  private async dispose(active: ActiveArtifact): Promise<void> {
    await active.watcher.close();
    active.artifactSession.protocol.unhandle(ARTIFACT_SCHEME);
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

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isArtifactUrlAllowed, STATIC_ARTIFACT_CSP } from "../artifacts/security-policy";
import { resolveArtifactFile } from "./artifact-paths";

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

export interface StaticArtifactRequest {
  url: string;
  method: string;
}

/** The `geode-artifact:` protocol handler for one static artifact. Electron-free so it can be unit tested. */
export function createStaticArtifactHandler(
  artifactId: string,
  root: string,
): (request: StaticArtifactRequest) => Promise<Response> {
  return async (request) => {
    if (!isArtifactUrlAllowed(request.url, artifactId, "document")) {
      return response(403, "Artifact origin denied.");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response(405, "Method not allowed.", { allow: "GET, HEAD" });
    }
    const relativePath = artifactPathname(request.url);
    if (!relativePath) return response(404, "Artifact file not found.");
    try {
      const { file: filePath } = await resolveArtifactFile(root, relativePath);
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
      // Missing, unreadable, escaping and reserved paths all land here on purpose: one indistinguishable 404.
      return response(404, "Artifact file not found.");
    }
  };
}

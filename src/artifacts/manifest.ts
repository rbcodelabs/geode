export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const;

export type ArtifactViewportPreset = "desktop" | "tablet" | "mobile" | "custom";

export interface ArtifactManifest {
  schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION;
  id: string;
  title: string;
  entry: string;
  runtime: "static";
  createdByThreadId: string;
  viewport: {
    preset: ArtifactViewportPreset;
    width: number;
    height: number;
  };
  permissions: {
    network: "none";
    clipboard: false;
  };
}

export type ArtifactManifestIssueCode =
  | "invalid_type"
  | "invalid_value"
  | "missing_field"
  | "unknown_field"
  | "unsupported_schema";

export interface ArtifactManifestIssue {
  code: ArtifactManifestIssueCode;
  path: string;
  message: string;
}

export type ArtifactManifestParseResult =
  | { ok: true; manifest: ArtifactManifest }
  | { ok: false; issues: ArtifactManifestIssue[] };

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "id",
  "title",
  "entry",
  "runtime",
  "createdByThreadId",
  "viewport",
  "permissions",
]);
const VIEWPORT_FIELDS = new Set(["preset", "width", "height"]);
const PERMISSION_FIELDS = new Set(["network", "clipboard"]);
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addUnknownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  parentPath: string,
  issues: ArtifactManifestIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({
        code: "unknown_field",
        path: parentPath ? `${parentPath}.${key}` : key,
        message: `Unknown field "${key}".`,
      });
    }
  }
}

function required(value: Record<string, unknown>, key: string, issues: ArtifactManifestIssue[]): unknown {
  if (!(key in value)) {
    issues.push({ code: "missing_field", path: key, message: `Missing required field "${key}".` });
  }
  return value[key];
}

function validateString(
  value: unknown,
  path: string,
  issues: ArtifactManifestIssue[],
  options: { min: number; max: number; pattern?: RegExp; description?: string },
): value is string {
  if (typeof value !== "string") {
    issues.push({ code: "invalid_type", path, message: "Expected a string." });
    return false;
  }
  if (value.length < options.min || value.length > options.max || (options.pattern && !options.pattern.test(value))) {
    issues.push({
      code: "invalid_value",
      path,
      message: options.description ?? `Expected ${options.min}-${options.max} characters.`,
    });
    return false;
  }
  return true;
}

function validateEntry(entry: unknown, issues: ArtifactManifestIssue[]): entry is string {
  if (!validateString(entry, "entry", issues, { min: 1, max: 512 })) return false;
  const segments = entry.split("/");
  const portableRelativePath =
    !entry.startsWith("/") &&
    !entry.includes("\\") &&
    !entry.includes("\0") &&
    !/^[A-Za-z]:/.test(entry) &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!portableRelativePath) {
    issues.push({
      code: "invalid_value",
      path: "entry",
      message: "Entry must be a portable relative path without empty, dot, or parent segments.",
    });
    return false;
  }
  return true;
}

function validateDimension(value: unknown, path: string, issues: ArtifactManifestIssue[]): value is number {
  if (!Number.isInteger(value) || (value as number) < 240 || (value as number) > 7680) {
    issues.push({ code: "invalid_value", path, message: "Expected an integer between 240 and 7680." });
    return false;
  }
  return true;
}

export function parseArtifactManifest(value: unknown): ArtifactManifestParseResult {
  const issues: ArtifactManifestIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: "invalid_type", path: "$", message: "Expected a JSON object." }] };
  }

  addUnknownFields(value, ROOT_FIELDS, "", issues);
  const schemaVersion = required(value, "schemaVersion", issues);
  if (schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    issues.push({
      code: "unsupported_schema",
      path: "schemaVersion",
      message: `Expected schema version ${ARTIFACT_MANIFEST_SCHEMA_VERSION}.`,
    });
  }

  const id = required(value, "id", issues);
  validateString(id, "id", issues, {
    min: 1,
    max: 64,
    pattern: ID_PATTERN,
    description: "Use 1-64 lowercase letters, numbers, underscores, or hyphens; start and end alphanumeric.",
  });
  const title = required(value, "title", issues);
  validateString(title, "title", issues, { min: 1, max: 120 });
  const entry = required(value, "entry", issues);
  validateEntry(entry, issues);
  const runtime = required(value, "runtime", issues);
  if (runtime !== "static") {
    issues.push({ code: "invalid_value", path: "runtime", message: 'Only runtime "static" is supported.' });
  }
  const createdByThreadId = required(value, "createdByThreadId", issues);
  validateString(createdByThreadId, "createdByThreadId", issues, {
    min: 1,
    max: 128,
    pattern: THREAD_ID_PATTERN,
    description: "Use 1-128 identifier characters without whitespace or path separators.",
  });

  const viewport = required(value, "viewport", issues);
  if (!isRecord(viewport)) {
    issues.push({ code: "invalid_type", path: "viewport", message: "Expected an object." });
  } else {
    addUnknownFields(viewport, VIEWPORT_FIELDS, "viewport", issues);
    const preset = viewport.preset;
    if (!["desktop", "tablet", "mobile", "custom"].includes(String(preset))) {
      issues.push({ code: "invalid_value", path: "viewport.preset", message: "Expected desktop, tablet, mobile, or custom." });
    }
    validateDimension(viewport.width, "viewport.width", issues);
    validateDimension(viewport.height, "viewport.height", issues);
  }

  const permissions = required(value, "permissions", issues);
  if (!isRecord(permissions)) {
    issues.push({ code: "invalid_type", path: "permissions", message: "Expected an object." });
  } else {
    addUnknownFields(permissions, PERMISSION_FIELDS, "permissions", issues);
    if (permissions.network !== "none") {
      issues.push({ code: "invalid_value", path: "permissions.network", message: 'Only network permission "none" is supported.' });
    }
    if (permissions.clipboard !== false) {
      issues.push({ code: "invalid_value", path: "permissions.clipboard", message: "Clipboard access must be false." });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest: value as unknown as ArtifactManifest };
}

export function parseArtifactManifestJson(json: string): ArtifactManifestParseResult {
  try {
    return parseArtifactManifest(JSON.parse(json));
  } catch {
    return { ok: false, issues: [{ code: "invalid_value", path: "$", message: "Manifest is not valid JSON." }] };
  }
}

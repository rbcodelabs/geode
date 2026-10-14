/** Serializable diagnostics: never carry arbitrary exception messages or stacks. */
export interface VaultRefreshFailure {
  operation: "scan" | "read-directory" | "stat" | "pause-autosave" | "read-file" | "prepare-recovery" | "refresh-editors" | "save-manifest" | "finish-refresh";
  category: "permission" | "content-unavailable" | "missing-path" | "unsupported-link" | "unsupported-entry" | "internal";
  code: string;
  /** Error type name (for example "TypeError") when the code is unknown. Allowlisted, never a message or stack. */
  cause?: string;
  path?: string;
}

export interface VaultRefreshResult<T> {
  status: "complete" | "partial" | "cancelled" | "unavailable";
  entries: T[];
  errorCode?: string;
  failure?: VaultRefreshFailure;
  /** Sync scans only: paths that exist but cannot be read as ordinary files (iCloud placeholders). Untouchable by sync. */
  blocked?: Array<{ path: string; reason: string }>;
}

export function safeRelativePath(value: string | undefined): string | undefined {
  if (!value || value.startsWith("/") || /[\\:?#\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value) || value.split("/").some(p => p === ".." || p === ".")) return undefined;
  return value;
}

/** Error type names that are safe to copy into diagnostics: fixed identifiers, never user text. */
const SAFE_CAUSE_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AbortError", "DataCloneError", "DataError",
  "InvalidStateError", "NotFoundError", "NotAllowedError", "ConstraintError", "ReadOnlyError", "TransactionInactiveError", "UnknownError",
  "VersionError", "SecurityError", "NetworkError", "TimeoutError", "EncodingError", "OperationError", "NotReadableError", "NoModificationAllowedError",
]);

/** DOMException.code 22 (and Firefox's 1014) with the standard name: the webview's storage quota was exceeded. */
function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || (typeof code === "number" && (code === 22 || code === 1014) && typeof name === "string" && /quota/i.test(name));
}

export function vaultRefreshFailure(error: unknown, operation: VaultRefreshFailure["operation"] = "scan", relativePath?: string): VaultRefreshFailure {
  let candidate = error && typeof error === "object" ? (error as { code?: unknown }).code : error;
  if (isQuotaExceeded(error)) candidate = "STORAGE_QUOTA_EXCEEDED";
  const known: Record<string, VaultRefreshFailure["category"]> = {
    EACCES: "permission", EPERM: "permission", VAULT_PERMISSION_DENIED: "permission", VAULT_ACCESS_REVOKED: "permission",
    VAULT_PERMISSION_REVOKED: "permission", VAULT_MISSING: "missing-path", VAULT_UNAVAILABLE: "internal",
    CONTENT_UNAVAILABLE: "content-unavailable", ENOENT: "missing-path", ENOTDIR: "missing-path", VAULT_NOT_FOUND: "missing-path",
    SYMLINK_UNSUPPORTED: "unsupported-link", ENTRY_UNSUPPORTED: "unsupported-entry",
    EIO: "internal", ETIMEDOUT: "internal", EBUSY: "internal", EMFILE: "internal", ENFILE: "internal", ENOSPC: "internal", EROFS: "internal", EDQUOT: "internal",
    STORAGE_QUOTA_EXCEEDED: "internal",
  };
  // Native plugin codes (Capacitor: "UNIMPLEMENTED", "IO_FAILURE", ...) are fixed upper-case identifiers, so they can
  // be copied without risking a path or note text; anything else stays UNKNOWN.
  const identifier = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(candidate) ? candidate : undefined;
  const code = typeof candidate === "string" && Object.hasOwn(known, candidate) ? candidate : identifier ?? "UNKNOWN";
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  const cause = code === "UNKNOWN" && typeof name === "string" && SAFE_CAUSE_NAMES.has(name) ? name : undefined;
  const safeOperation = ["scan", "read-directory", "stat", "pause-autosave", "read-file", "prepare-recovery", "refresh-editors", "save-manifest", "finish-refresh"].includes(operation) ? operation : "scan";
  return { operation: safeOperation, category: known[code] ?? "internal", code, ...(cause ? { cause } : {}), ...(safeRelativePath(relativePath) ? { path: relativePath } : {}) };
}

export function vaultRefreshPresentation(status: string, failure: VaultRefreshFailure, context: { version: string; savesPaused: boolean; manifestCommitted?: boolean }) {
  failure = vaultRefreshFailure({ code: failure.code, name: failure.cause }, failure.operation, failure.path);
  const explanation: Record<VaultRefreshFailure["category"], string> = {
    permission: "Access was denied while refreshing the vault. Check folder access permissions, then retry. On mobile, reconnect the same vault if access needs renewing.",
    "content-unavailable": "The provider reports content unavailable. Make the affected item available offline, then retry.",
    "missing-path": "A vault folder or file could not be found. Check that it is still available at its expected location, then retry.",
    "unsupported-link": "A symbolic link cannot be scanned safely. Move the link outside the visible vault or replace it with an ordinary file or folder, then retry.",
    "unsupported-entry": "A filesystem entry is not a supported file or folder. Move it outside the visible vault, then retry.",
    internal: "Geode could not finish the refresh. Retry; if it keeps failing, copy the diagnostic report for troubleshooting.",
  };
  let reason = status === "partial" || status === "cancelled" ? "Vault refresh was incomplete." : explanation[failure.category];
  if (failure.code === "ENOSPC" || failure.code === "EDQUOT") reason = "There is not enough storage available to finish the refresh. Free up space, then retry.";
  if (failure.code === "STORAGE_QUOTA_EXCEEDED") reason = "Geode's on-device storage for the file list is full. Retry; your notes were not changed. If it keeps failing, copy the diagnostic report for troubleshooting.";
  if (failure.code === "EROFS") reason = "The storage is read-only. Restore write access, then retry.";
  const preservation = context.manifestCommitted ? "The file list was refreshed, but a follow-up step failed." : "The previous file list is still active; this refresh did not replace it.";
  const edits = context.savesPaused ? " Saves remain paused. Keep Geode open and copy unsaved text somewhere safe before retrying. Check any note recovery banners for recovery-copy status."
    : failure.operation === "scan" || failure.operation === "read-directory" || failure.operation === "stat" ? "" : " Some editor or recovery steps may already have completed. Check note recovery banners; unsaved text is not guaranteed to be on disk.";
  const safe = vaultRefreshFailure({ code: failure.code, name: failure.cause }, failure.operation, failure.path);
  const causeLine = safe.cause ? `\nCause: ${safe.cause}` : "";
  const details = `Operation: ${safe.operation}\nCategory: ${safe.category}\nCode: ${safe.code}${causeLine}\nPath: ${safe.path ?? "Not available (or vault root)"}`;
  const report = `Geode ${context.version}\nVault refresh: ${status}\nOperation: ${safe.operation}\nCategory: ${safe.category}\nCode: ${safe.code}${causeLine}\nPath: ${safe.path ? "<redacted>" : "Not available (or vault root)"}\nRefresh holding saves: ${context.savesPaused ? "yes" : "no"}\nManifest committed: ${context.manifestCommitted ? "yes" : "no"}`;
  const banner = context.manifestCommitted ? "File list refreshed; a follow-up step failed." : "Vault refresh failed. Your previous file list is unchanged.";
  const sentenceEnd = reason.indexOf(". ");
  return {
    banner: context.savesPaused ? `${context.manifestCommitted ? banner : "Vault refresh failed."} Saving is paused—keep Geode open.` : banner,
    message: `${reason} ${preservation}${edits}`, details, report,
    cause: sentenceEnd < 0 ? reason : reason.slice(0, sentenceEnd + 1),
    guidance: sentenceEnd < 0 ? "Retry; if it keeps failing, copy diagnostics for troubleshooting." : reason.slice(sentenceEnd + 2),
    preservation: `${context.manifestCommitted ? preservation : "Your previous file list is unchanged."} This does not confirm that unsaved edits are on disk.`,
    warning: context.savesPaused ? "Saving is paused. Keep Geode open and copy unsaved text somewhere safe. Check note recovery warnings before retrying." : undefined,
    rows: [ { label: "Operation", value: safe.operation }, { label: "Error code", value: safe.code }, ...(safe.cause ? [{ label: "Cause", value: safe.cause }] : []), { label: "Path in vault", value: safe.path ?? "Not available (or vault root)" } ],
  };
}

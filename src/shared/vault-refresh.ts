/** Serializable diagnostics: never carry arbitrary exception messages or stacks. */
export interface VaultRefreshFailure {
  operation: "scan" | "read-directory" | "stat" | "pause-autosave" | "read-file" | "prepare-recovery" | "refresh-editors" | "save-manifest" | "finish-refresh";
  category: "permission" | "content-unavailable" | "missing-path" | "unsupported-link" | "unsupported-entry" | "internal";
  code: string;
  path?: string;
}

export interface VaultRefreshResult<T> {
  status: "complete" | "partial" | "cancelled" | "unavailable";
  entries: T[];
  errorCode?: string;
  failure?: VaultRefreshFailure;
}

export function safeRelativePath(value: string | undefined): string | undefined {
  if (!value || value.startsWith("/") || /[\\:?#\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value) || value.split("/").some(p => p === ".." || p === ".")) return undefined;
  return value;
}

export function vaultRefreshFailure(error: unknown, operation: VaultRefreshFailure["operation"] = "scan", relativePath?: string): VaultRefreshFailure {
  const candidate = error && typeof error === "object" ? (error as { code?: unknown }).code : error;
  const known: Record<string, VaultRefreshFailure["category"]> = {
    EACCES: "permission", EPERM: "permission", VAULT_PERMISSION_DENIED: "permission", VAULT_ACCESS_REVOKED: "permission",
    VAULT_PERMISSION_REVOKED: "permission", VAULT_MISSING: "missing-path", VAULT_UNAVAILABLE: "internal",
    CONTENT_UNAVAILABLE: "content-unavailable", ENOENT: "missing-path", ENOTDIR: "missing-path", VAULT_NOT_FOUND: "missing-path",
    SYMLINK_UNSUPPORTED: "unsupported-link", ENTRY_UNSUPPORTED: "unsupported-entry",
    EIO: "internal", ETIMEDOUT: "internal", EBUSY: "internal", EMFILE: "internal", ENFILE: "internal", ENOSPC: "internal", EROFS: "internal", EDQUOT: "internal",
  };
  const code = typeof candidate === "string" && Object.hasOwn(known, candidate) ? candidate : "UNKNOWN";
  const safeOperation = ["scan", "read-directory", "stat", "pause-autosave", "read-file", "prepare-recovery", "refresh-editors", "save-manifest", "finish-refresh"].includes(operation) ? operation : "scan";
  return { operation: safeOperation, category: known[code] ?? "internal", code, ...(safeRelativePath(relativePath) ? { path: relativePath } : {}) };
}

export function vaultRefreshPresentation(status: string, failure: VaultRefreshFailure, context: { version: string; savesPaused: boolean; manifestCommitted?: boolean }) {
  failure = vaultRefreshFailure({ code: failure.code }, failure.operation, failure.path);
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
  if (failure.code === "EROFS") reason = "The storage is read-only. Restore write access, then retry.";
  const preservation = context.manifestCommitted ? "The file list was refreshed, but a follow-up step failed." : "The previous file list is still active; this refresh did not replace it.";
  const edits = context.savesPaused ? " Saves remain paused. Keep Geode open and copy unsaved text somewhere safe before retrying. Check any note recovery banners for recovery-copy status."
    : failure.operation === "scan" || failure.operation === "read-directory" || failure.operation === "stat" ? "" : " Some editor or recovery steps may already have completed. Check note recovery banners; unsaved text is not guaranteed to be on disk.";
  const safe = vaultRefreshFailure({ code: failure.code }, failure.operation, failure.path);
  const details = `Operation: ${safe.operation}\nCategory: ${safe.category}\nCode: ${safe.code}\nPath: ${safe.path ?? "Not available (or vault root)"}`;
  const report = `Geode ${context.version}\nVault refresh: ${status}\nOperation: ${safe.operation}\nCategory: ${safe.category}\nCode: ${safe.code}\nPath: ${safe.path ? "<redacted>" : "Not available (or vault root)"}\nRefresh holding saves: ${context.savesPaused ? "yes" : "no"}\nManifest committed: ${context.manifestCommitted ? "yes" : "no"}`;
  const banner = context.manifestCommitted ? "File list refreshed; a follow-up step failed." : "Vault refresh failed. Your previous file list is unchanged.";
  const sentenceEnd = reason.indexOf(". ");
  return {
    banner: context.savesPaused ? `${context.manifestCommitted ? banner : "Vault refresh failed."} Saving is paused—keep Geode open.` : banner,
    message: `${reason} ${preservation}${edits}`, details, report,
    cause: sentenceEnd < 0 ? reason : reason.slice(0, sentenceEnd + 1),
    guidance: sentenceEnd < 0 ? "Retry; if it keeps failing, copy diagnostics for troubleshooting." : reason.slice(sentenceEnd + 2),
    preservation: `${context.manifestCommitted ? preservation : "Your previous file list is unchanged."} This does not confirm that unsaved edits are on disk.`,
    warning: context.savesPaused ? "Saving is paused. Keep Geode open and copy unsaved text somewhere safe. Check note recovery warnings before retrying." : undefined,
    rows: [ { label: "Operation", value: safe.operation }, { label: "Error code", value: safe.code }, { label: "Path in vault", value: safe.path ?? "Not available (or vault root)" } ],
  };
}

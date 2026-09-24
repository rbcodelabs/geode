import { expect, it } from "vitest";
import * as refresh from "../../src/shared/vault-refresh";

it.each(["/Users/private/note.md", "../note.md", "C:\\secret.md", "https://example.com", "note.md?token=secret", "note\nsecret.md", "file\u202etxt.md", "file#secret"])("redacts unsafe paths: %s", path => {
  expect(refresh.safeRelativePath(path)).toBeUndefined();
});
it.each(["EIO", "ETIMEDOUT", "EBUSY", "ENOSPC", "EDQUOT", "EROFS", "ENFILE", "EMFILE"])("preserves the known underlying %s code without guessing a cloud cause", code => {
  expect(refresh.vaultRefreshFailure({ code })).toMatchObject({ code, category: "internal" });
});
it.each([ ["EACCES", "permission"], ["EPERM", "permission"], ["CONTENT_UNAVAILABLE", "content-unavailable"], ["ENOENT", "missing-path"], ["EIO", "internal"], ["VAULT_PERMISSION_REVOKED", "permission"], ["VAULT_MISSING", "missing-path"] ])("classifies %s without guessing", (code, category) => {
  expect(refresh.vaultRefreshFailure({ code, message: "private note content" }).category).toBe(category);
});
it("explains failures without leaking raw messages or copied filenames", () => {
  const failure = refresh.vaultRefreshFailure({ code: "EACCES", message: "private content" }, "read-directory", "Private/Note.md");
  const present = refresh.vaultRefreshPresentation;
  const result = present("unavailable", failure, { version: "1.2.3", savesPaused: false });
  expect(result.message).toContain("denied");
  expect(result.message).not.toContain("revoked");
  expect(result.report).toContain("1.2.3");
  expect(result.report).toContain("EACCES");
  expect(result.report).not.toContain("Private");
  expect(result.report).not.toContain("private content");
});
it("does not claim disk durability when editor refresh failed with saves paused", () => {
  const present = refresh.vaultRefreshPresentation;
  const result = present("unavailable", refresh.vaultRefreshFailure(null, "refresh-editors"), { version: "1", savesPaused: true });
  expect(result.message).toContain("Saves remain paused");
  expect(result.message).toContain("Keep Geode open");
  expect(result.message).not.toContain("edits are preserved");
});

it("does not claim the prior manifest is active after a committed refresh follow-up fails", () => {
  const result = refresh.vaultRefreshPresentation("unavailable", refresh.vaultRefreshFailure(null), { version: "1", savesPaused: false, manifestCommitted: true });
  expect(result.message).toContain("file list was refreshed");
  expect(result.message).not.toContain("previous file list is still active");
});

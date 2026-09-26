# When a vault refresh cannot finish

Vault refresh checks for files changed outside Geode. If a scan is incomplete or
fails, Geode does not treat the missing scan results as deleted files or replace
the previous file list with them.

The compact refresh banner shows file-list status and offers **Retry** and
**Details…**. Details opens a dialog with the known cause, recovery guidance,
failed operation and error code; it never opens automatically. Close it with
**Close** or Escape to return to your work. When available,
the affected path is relative to the vault, not an absolute location on your
computer.

## What the cause means

- **Access denied:** Geode could not access an item. Check access to that folder
  before retrying. This alone does not establish that app signing is at fault or
  that access was revoked.
- **Content unavailable:** The provider explicitly reported unavailable content.
  Check the provider's download/availability state, then retry. An ordinary I/O
  error is not proof that a cloud download is missing.
- **Missing item:** A file or folder disappeared during the operation. Check the
  affected path; a missing child file does not necessarily mean the entire vault
  moved.
- **Unsupported symbolic link or entry:** The refresh cannot safely include that
  item. Inspect it before moving or replacing it; do not delete unfamiliar files
  just to dismiss the banner.
- **Other failure:** Geode could not complete the indicated operation. Keep the
  diagnostic report if retrying does not resolve it.

Ordinary desktop refresh skips hidden trees, including `.geode/worktrees`, before
scanning their contents. Sync uses its own strict scan, which includes eligible
configuration data and still rejects unreadable or unsupported entries. A failed
sync scan never establishes that files were deleted.

## File-list preservation is not a save confirmation

Keeping the previous file list does not mean all edits have been saved to disk.
Follow any editor-specific conflict or recovery warning as well as the refresh
banner. In particular, if edits exist only in an open editor, copy them somewhere
safe before closing it. If the banner says saving is paused, resolve the cause
and retry the refresh before assuming saving has resumed.

## Sharing diagnostics

**Copy diagnostics** in the details dialog copies the app version and structured failure details
for troubleshooting. Paths are redacted in the copied report. Note contents,
raw exception messages and stack traces are not included. You can inspect the
report before sharing it; copying it does not automatically send it anywhere.

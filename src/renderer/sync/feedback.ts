import type { SyncPreview } from './types';
type Result = Omit<SyncPreview, 'requiresApproval'> & { requiresApproval?: boolean };
export function formatSyncFeedback(action: 'preview' | 'run', result: Result, appendOnly: boolean, details?: { upToDate: boolean }): string {
  const nothingPending = [result.uploads, result.downloads, result.deletes, result.conflicts, result.skipped].every(count => count === 0);
  if (action === 'run' && appendOnly && details?.upToDate === true && !result.requiresApproval && nothingPending) return 'Up to date. No changes pending.';
  const label = action === 'preview' ? 'Preview — pending' : appendOnly ? 'Remaining' : 'Sync result';
  const approval = result.requiresApproval ? ' Review before approving the first sync.' : '';
  return `${label}: ${result.uploads} upload, ${result.downloads} download, ${result.deletes} deletions, ${result.conflicts} conflict, ${result.skipped} skipped.${approval}`;
}
export function renderSyncFeedback(container: HTMLElement, summary: string): void {
  const element = container.ownerDocument.createElement('p');
  element.setAttribute('role', 'status'); element.textContent = summary; container.appendChild(element);
}

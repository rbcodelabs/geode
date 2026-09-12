import { describe, expect, it, vi } from 'vitest';
import { formatSyncFeedback, renderSyncFeedback } from '../../src/renderer/sync/feedback';

const zero = { uploads: 0, downloads: 0, deletes: 0, conflicts: 0, skipped: 0, requiresApproval: false };
describe('Sync settings feedback', () => {
  it.each(['uploads', 'downloads', 'deletes', 'conflicts', 'skipped'])('does not hide contradictory %s counts behind up-to-date details', field => {
    expect(formatSyncFeedback('run', { ...zero, [field]: 1 }, true, { upToDate: true })).not.toContain('Up to date');
  });
  it('renders confirmed up-to-date append-only completion without first-sync instructions', () => {
    const service = { isAppendOnly: () => true, getHistoryDetails: () => ({ upToDate: true }) };
    const text = formatSyncFeedback('run', zero, service.isAppendOnly(), service.getHistoryDetails());
    const element = { setAttribute: vi.fn(), textContent: '' };
    const container = { ownerDocument: { createElement: () => element }, appendChild: vi.fn() };
    renderSyncFeedback(container as unknown as HTMLElement, text);
    expect(element.textContent).toBe('Up to date. No changes pending.');
    expect(element.setAttribute).toHaveBeenCalledWith('role', 'status');
    expect(container.appendChild).toHaveBeenCalledWith(element);
  });
  it('never infers up to date from zero remaining counters', () => {
    expect(formatSyncFeedback('run', zero, true, { upToDate: false })).toContain('Remaining:');
    expect(formatSyncFeedback('run', zero, true, undefined)).not.toContain('Up to date');
  });
  it('shows preview counts as pending and approval instructions only when needed', () => {
    const pending = { ...zero, uploads: 2, requiresApproval: true };
    expect(formatSyncFeedback('preview', pending, true)).toContain('Preview — pending: 2 upload');
    expect(formatSyncFeedback('preview', pending, true)).toContain('Review before approving');
    expect(formatSyncFeedback('preview', { ...pending, requiresApproval: false }, true)).not.toContain('approving');
  });
  it('does not describe remaining append-only work as completed transfers', () => {
    expect(formatSyncFeedback('run', { ...zero, uploads: 2, skipped: 1 }, true, { upToDate: false })).toContain('Remaining: 2 upload');
  });
  it('does not label conditional run executed counts as remaining or add approval instructions', () => {
    const text = formatSyncFeedback('run', { ...zero, uploads: 2 }, false);
    expect(text).toContain('Sync result: 2 upload');
    expect(text).not.toMatch(/Remaining|approving|Up to date/);
  });
});

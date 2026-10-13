import { describe, expect, it } from 'vitest';
import { describeSyncCard, formatRelativeTime } from '../../src/renderer/sync/status-card';

const NOW = 1_800_000_000_000;
const base = { state: 'idle' as const, conflicts: 0, connected: true, isHub: false, bound: true, requiresApproval: false, blocked: 0, lastSyncedAt: NOW - 120_000, now: NOW };

describe('formatRelativeTime', () => {
  it.each([
    [0, 'just now'], [30_000, 'just now'], [60_000, '1 minute ago'], [120_000, '2 minutes ago'],
    [3_600_000, '1 hour ago'], [7_200_000, '2 hours ago'], [86_400_000, '1 day ago'], [3 * 86_400_000, '3 days ago'],
  ])('%i ms ago reads %s', (age, text) => expect(formatRelativeTime(NOW - age, NOW)).toBe(text));
  it('never reports a negative or future age', () => expect(formatRelativeTime(NOW + 5000, NOW)).toBe('just now'));
});

describe('describeSyncCard', () => {
  it('says set up when no provider is connected', () => {
    const card = describeSyncCard({ ...base, connected: false, state: 'disconnected', lastSyncedAt: undefined });
    expect(card).toMatchObject({ tone: 'idle', headline: 'Sync is not set up', primary: 'setup' });
  });
  it('keeps the hub "Setup needed" wording before a shared vault is bound', () => {
    const card = describeSyncCard({ ...base, isHub: true, bound: false, state: 'preview' });
    expect(card.headline).toBe('Setup needed');
    expect(card.primary).toBe('setup');
  });
  it('says setup is needed for any shared-vault provider with no bound vault, not "preview ready"', () => {
    const card = describeSyncCard({ ...base, isHub: false, bound: false, state: 'preview', message: 'Create or join a shared vault' });
    expect(card).toMatchObject({ tone: 'warn', headline: 'Setup needed', sub: 'Create or join a shared vault to start syncing.', primary: 'setup' });
  });
  it('reports a healthy vault with its last sync time', () => {
    const card = describeSyncCard(base);
    expect(card).toMatchObject({ tone: 'ok', headline: 'Up to date', sub: 'Last synced 2 minutes ago', primary: 'sync' });
  });
  it('does not invent a last-synced time', () => {
    expect(describeSyncCard({ ...base, lastSyncedAt: undefined }).sub).toBe('Not synced yet in this session');
  });
  it('shows progress tone while syncing, with no competing primary action', () => {
    expect(describeSyncCard({ ...base, state: 'syncing' })).toMatchObject({ tone: 'busy', headline: 'Syncing…', primary: 'none' });
  });
  it('puts conflicts ahead of everything else', () => {
    const card = describeSyncCard({ ...base, state: 'conflict', conflicts: 3 });
    expect(card).toMatchObject({ tone: 'warn', headline: '3 conflicts need your decision', primary: 'resolve' });
    expect(describeSyncCard({ ...base, conflicts: 1 }).headline).toBe('1 conflict needs your decision');
  });
  it('asks for plan review before a first sync', () => {
    const card = describeSyncCard({ ...base, state: 'preview', isHub: true, requiresApproval: true });
    expect(card).toMatchObject({ tone: 'warn', headline: 'Review the first sync plan', primary: 'review' });
  });
  it('only offers plan review where a plan row exists (the hub), otherwise approval', () => {
    expect(describeSyncCard({ ...base, state: 'preview', isHub: false, requiresApproval: true }).primary).toBe('approve');
  });
  it('offers approval for a non-hub preview', () => {
    expect(describeSyncCard({ ...base, state: 'preview' })).toMatchObject({ headline: 'Preview ready', primary: 'approve' });
  });
  it('offers resume when paused', () => {
    expect(describeSyncCard({ ...base, state: 'paused' })).toMatchObject({ tone: 'idle', headline: 'Sync is paused', primary: 'resume' });
  });
  it('turns an error into a next step using the engine message', () => {
    const card = describeSyncCard({ ...base, state: 'error', message: 'Scan found 3 of 900 files' });
    expect(card).toMatchObject({ tone: 'bad', headline: 'Sync stopped', sub: 'Scan found 3 of 900 files', primary: 'retry' });
  });
  it('supplies a fallback next step when an error carries no message', () => {
    expect(describeSyncCard({ ...base, state: 'error' }).sub).toBe('Check the connection, then try again.');
  });
  it('mentions blocked files without changing a healthy tone to an error', () => {
    const card = describeSyncCard({ ...base, blocked: 23 });
    expect(card.tone).toBe('ok');
    expect(card.sub).toBe('Last synced 2 minutes ago · 23 files blocked');
  });
});

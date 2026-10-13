import type { SyncStatusState } from './types';

/** What the card's single emphasised button should do. `none` means work is already in flight. */
export type SyncCardPrimary = 'setup' | 'resolve' | 'review' | 'approve' | 'resume' | 'retry' | 'sync' | 'none';
export type SyncCardTone = 'ok' | 'busy' | 'warn' | 'bad' | 'idle';

export interface SyncCardInput {
  state: SyncStatusState;
  conflicts: number;
  message?: string;
  connected: boolean;
  isHub: boolean;
  /** A shared vault is bound. Always true for providers that have no shared-vault concept. */
  bound: boolean;
  /** The first-sync plan is waiting for the user's confirmation. */
  requiresApproval: boolean;
  blocked: number;
  lastSyncedAt?: number;
  now: number;
}

export interface SyncCardView { tone: SyncCardTone; headline: string; sub: string; primary: SyncCardPrimary; }

export function formatRelativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return unit(Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return unit(Math.floor(seconds / 3600), 'hour');
  return unit(Math.floor(seconds / 86_400), 'day');
}

/**
 * Turns the engine's raw state into the sentence, tone and single next action
 * the Sync tab leads with. Precedence matters: things that need the user
 * (setup, conflicts, plan review, errors) outrank a healthy "up to date".
 */
export function describeSyncCard(input: SyncCardInput): SyncCardView {
  const synced = input.lastSyncedAt === undefined ? 'Not synced yet in this session' : `Last synced ${formatRelativeTime(input.lastSyncedAt, input.now)}`;
  const withBlocked = input.blocked > 0 ? `${synced} · ${input.blocked} file${input.blocked === 1 ? '' : 's'} blocked` : synced;
  if (!input.connected) return { tone: 'idle', headline: 'Sync is not set up', sub: 'Choose a provider to keep this vault in sync across devices.', primary: 'setup' };
  if (!input.bound) return { tone: 'warn', headline: 'Setup needed', sub: input.isHub ? 'Choose a hub location, then create or join a shared vault.' : 'Create or join a shared vault to start syncing.', primary: 'setup' };
  if (input.state === 'error') return { tone: 'bad', headline: 'Sync stopped', sub: input.message || 'Check the connection, then try again.', primary: 'retry' };
  if (input.state === 'syncing') return { tone: 'busy', headline: 'Syncing…', sub: withBlocked, primary: 'none' };
  if (input.conflicts > 0) return { tone: 'warn', headline: `${input.conflicts} conflict${input.conflicts === 1 ? '' : 's'} need${input.conflicts === 1 ? 's' : ''} your decision`, sub: withBlocked, primary: 'resolve' };
  if (input.requiresApproval && input.isHub) return { tone: 'warn', headline: 'Review the first sync plan', sub: 'Nothing changes until you confirm.', primary: 'review' };
  if (input.state === 'paused') return { tone: 'idle', headline: 'Sync is paused', sub: withBlocked, primary: 'resume' };
  if (input.state === 'preview') return { tone: 'warn', headline: 'Preview ready', sub: input.message || 'Review the changes, then approve the sync.', primary: 'approve' };
  return { tone: 'ok', headline: 'Up to date', sub: withBlocked, primary: 'sync' };
}

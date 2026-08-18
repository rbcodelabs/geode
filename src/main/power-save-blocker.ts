import { randomUUID } from "node:crypto";

export interface PowerSaveBlockerAdapter {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

interface OwnedBlocker {
  blockerId: number;
  ownerId: number;
}

/**
 * Owns Electron power-save blockers on behalf of renderer processes without
 * exposing Electron blocker IDs across the IPC boundary.
 */
export class PowerSaveBlockerRegistry {
  private readonly blockers = new Map<string, OwnedBlocker>();

  constructor(private readonly adapter: PowerSaveBlockerAdapter) {}

  acquire(ownerId: number): string {
    const blockerId = this.adapter.start("prevent-app-suspension");
    const token = randomUUID();
    this.blockers.set(token, { blockerId, ownerId });
    return token;
  }

  release(ownerId: number, token: string): boolean {
    const blocker = this.blockers.get(token);
    if (!blocker || blocker.ownerId !== ownerId) return false;
    this.blockers.delete(token);
    this.stopSafely(blocker.blockerId);
    return true;
  }

  releaseOwner(ownerId: number): void {
    for (const [token, blocker] of this.blockers) {
      if (blocker.ownerId !== ownerId) continue;
      this.blockers.delete(token);
      this.stopSafely(blocker.blockerId);
    }
  }

  private stopSafely(blockerId: number): void {
    try {
      this.adapter.stop(blockerId);
    } catch {
      // The renderer may be destroyed while Electron is already tearing down.
    }
  }
}

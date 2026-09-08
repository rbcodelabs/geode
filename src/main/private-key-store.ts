import * as fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const pending = new Map<string, Promise<unknown>>();

/** Main-process-only opaque bytes; encryption and owner validation remain with the caller. */
export class PrivateKeyStore {
  constructor(private directory: string, private extension: 'json' | 'bin', private io: typeof fsp = fsp) {}

  read(identity: string): Promise<Buffer | null> {
    const paths = this.paths(identity);
    return this.lock(paths.target, async () => {
      const current = await this.readOptional(paths.target);
      if (current !== null) return current;
      const legacy = paths.legacy ? await this.readOptional(paths.legacy) : null;
      if (legacy === null) return null;
      await this.commit(paths.target, legacy);
      await this.removeLegacy(paths.legacy);
      return legacy;
    });
  }

  write(identity: string, bytes: Uint8Array): Promise<void> {
    const paths = this.paths(identity); const owned = Buffer.from(bytes);
    return this.lock(paths.target, async () => {
      await this.commit(paths.target, owned);
      await this.removeLegacy(paths.legacy);
    });
  }

  remove(identity: string): Promise<void> {
    const paths = this.paths(identity);
    return this.lock(paths.target, async () => {
      // Remove the stale fallback first: a failed second unlink cannot resurrect old credentials.
      await this.removeLegacy(paths.legacy);
      await this.io.rm(paths.target, { force: true });
      await this.syncDirectory(this.directory, true);
    });
  }

  private paths(identity: string) {
    if (typeof identity !== 'string' || !identity) throw new Error('Invalid private storage identity');
    const target = resolve(this.directory, `${createHash('sha256').update(identity).digest('hex')}.${this.extension}`);
    const encoded = Buffer.from(identity).toString('base64url') + `.${this.extension}`;
    return { target, legacy: encoded.length <= 255 ? join(this.directory, encoded) : null };
  }

  private async readOptional(path: string): Promise<Buffer | null> {
    try { return await this.io.readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  private async commit(target: string, bytes: Buffer): Promise<void> {
    await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.syncDirectory(dirname(resolve(this.directory)));
    const temporary = join(this.directory, `.private-${randomUUID()}.tmp`);
    try {
      const handle = await this.io.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.io.rename(temporary, target);
      await this.syncDirectory(this.directory);
      if (!(await this.io.readFile(target)).equals(bytes)) throw new Error('Private storage verification failed');
    } finally {
      await this.io.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async removeLegacy(path: string | null): Promise<void> {
    if (!path) return;
    await this.io.rm(path, { force: true });
    await this.syncDirectory(this.directory, true);
  }

  private async syncDirectory(directory: string, allowMissing = false): Promise<void> {
    let handle: Awaited<ReturnType<typeof fsp.open>>;
    try { handle = await this.io.open(directory, 'r'); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private lock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (pending.get(key) ?? Promise.resolve()).then(work, work);
    const settled = run.then(() => undefined, () => undefined); pending.set(key, settled);
    void settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return run;
  }
}

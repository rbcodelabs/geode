import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PrivateKeyStore } from '../../src/main/private-key-store';

const directories: string[] = [];
async function mkdtemp(prefix: string) { const directory = await fsp.mkdtemp(prefix); directories.push(directory); return directory; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => fsp.rm(path, { recursive: true, force: true }))); });

describe('private key storage', () => {
  it('retains both recoverable copies when post-rename directory sync fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-')); const key = 'legacy';
    const legacy = join(directory, Buffer.from(key).toString('base64url') + '.bin'); await writeFile(legacy, 'original');
    let renamed = false;
    const io = { ...fsp, rename: vi.fn(async (...args: Parameters<typeof fsp.rename>) => { await fsp.rename(...args); renamed = true; }), open: vi.fn(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await fsp.open(...args);
      if (renamed && args[1] === 'r') handle.sync = async () => { throw new Error('sync failed'); };
      return handle;
    }) };
    await expect(new PrivateKeyStore(directory, 'bin', io).read(key)).rejects.toThrow('sync failed');
    expect(await readFile(legacy, 'utf8')).toBe('original');
    expect((await new PrivateKeyStore(directory, 'bin').read(key))?.toString()).toBe('original');
    expect((await readdir(directory)).length).toBe(2);
  });
  it('keeps the canonical value when legacy removal fails instead of revealing stale fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-')); const key = 'secret';
    const store = new PrivateKeyStore(directory, 'bin'); await store.write(key, Buffer.from('new'));
    const legacy = join(directory, Buffer.from(key).toString('base64url') + '.bin'); await writeFile(legacy, 'old');
    const io = { ...fsp, rm: vi.fn(async (...args: Parameters<typeof fsp.rm>) => { if (args[0] === legacy) throw new Error('unlink failed'); await fsp.rm(...args); }) };
    await expect(new PrivateKeyStore(directory, 'bin', io).remove(key)).rejects.toThrow('unlink failed');
    expect((await store.read(key))?.toString()).toBe('new');
    await store.remove(key); expect(await store.read(key)).toBeNull();
  });
  it('preserves legacy bytes and cleans its temporary file when migration rename fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-')); const key = 'legacy';
    const name = Buffer.from(key).toString('base64url') + '.bin'; await writeFile(join(directory, name), 'original');
    const store = new PrivateKeyStore(directory, 'bin', { ...fsp, rename: vi.fn(async () => { throw new Error('disk failure'); }) });
    await expect(store.read(key)).rejects.toThrow('disk failure');
    expect(await readFile(join(directory, name), 'utf8')).toBe('original'); expect(await readdir(directory)).toEqual([name]);
    expect((await new PrivateKeyStore(directory, 'bin').read(key))?.toString()).toBe('original');
  });
  it('syncs file contents before rename and directory metadata after rename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-')); const events: string[] = [];
    const io = { ...fsp, open: vi.fn(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await fsp.open(...args); const sync = handle.sync.bind(handle);
      handle.sync = async () => { events.push(args[1] === 'wx' ? 'file-sync' : 'directory-sync'); await sync(); };
      return handle;
    }), rename: vi.fn(async (...args: Parameters<typeof fsp.rename>) => { events.push('rename'); await fsp.rename(...args); }) };
    await new PrivateKeyStore(directory, 'bin', io).write('key', Buffer.from('value'));
    expect(events.indexOf('file-sync')).toBeLessThan(events.indexOf('rename'));
    expect(events.slice(events.indexOf('rename') + 1)).toContain('directory-sync');
  });
  it('stores long scoped keys under bounded hashed filenames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-'));
    const store = new PrivateKeyStore(directory, 'json'); const key = 'plugin/synthetic/'.repeat(100);
    await store.write(key, Buffer.from('value'));
    expect((await store.read(key))?.toString()).toBe('value');
    expect(await readdir(directory)).toEqual([`${createHash('sha256').update(key).digest('hex')}.json`]);
  });
  it('migrates legacy encrypted bytes without altering their encoding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-'));
    const key = 'owner\0secret'; const legacy = join(directory, Buffer.from(key).toString('base64url') + '.bin');
    await writeFile(legacy, Buffer.from([0, 255, 8]));
    const store = new PrivateKeyStore(directory, 'bin');
    expect(await store.read(key)).toEqual(Buffer.from([0, 255, 8]));
    expect(await readdir(directory)).toEqual([`${createHash('sha256').update(key).digest('hex')}.bin`]);
  });
  it('removes hashed and legacy copies so old credentials cannot resurrect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-')); const key = 'owner\0secret';
    const store = new PrivateKeyStore(directory, 'bin'); await store.write(key, Buffer.from('new'));
    await writeFile(join(directory, Buffer.from(key).toString('base64url') + '.bin'), 'old');
    await store.remove(key); expect(await store.read(key)).toBeNull(); expect(await readdir(directory)).toEqual([]);
  });
  it('serializes overlapping writes and deletion across instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-'));
    const first = new PrivateKeyStore(directory, 'json'); const second = new PrivateKeyStore(directory, 'json');
    await Promise.all([first.write('key', Buffer.from('one')), second.write('key', Buffer.from('two')), first.remove('key')]);
    expect(await second.read('key')).toBeNull();
  });
  it('does not conflate namespace and key boundaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-store-')); const store = new PrivateKeyStore(directory, 'bin');
    await store.write('a\0bc', Buffer.from('one')); await store.write('ab\0c', Buffer.from('two'));
    expect((await store.read('a\0bc'))?.toString()).toBe('one'); expect((await store.read('ab\0c'))?.toString()).toBe('two');
  });
});

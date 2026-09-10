import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const root = path.resolve(__dirname, '../..');
const providerId = 'immutable.multiclient-fixture';
type Client = { name: string; directory: string; vault: string; profile: string; app?: ElectronApplication; page?: Page };

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geode-multiclient-'));
  const records: any[] = []; const blobs = new Map<string, Buffer>(); const clients: Client[] = [];
  const offline = new Set<string>(); const requests: string[] = [];
  let binding: any; let loseRecordFor: string | undefined;
  const server = createServer(async (request, response) => {
    const client = String(request.headers['x-fixture-client']); const url = new URL(request.url!, 'http://fixture');
    requests.push(`${client}:${request.method}:${url.pathname}`);
    if (offline.has(client)) { response.writeHead(503); response.end('{}'); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/vaults') {
      if (request.method === 'POST') binding ??= { schema: 1, protocol: 'append-only-history-v1', vaultId: randomUUID(), rootId: 'synthetic-root', descriptorId: 'synthetic-descriptor', name: JSON.parse(body.toString()).name };
      json(request.method === 'POST' ? binding : binding ? [binding] : []); return;
    }
    if (url.pathname === '/records') {
      if (request.method === 'POST') {
        const record = JSON.parse(body.toString()); const old = records.find(value => value.recordId === record.recordId);
        if (old && JSON.stringify(old) !== JSON.stringify(record)) { response.writeHead(409); response.end('{}'); return; }
        if (!old) records.push(record);
        if (loseRecordFor === client && record.location.name === 'Note.md') { loseRecordFor = undefined; offline.add(client); response.destroy(); return; }
        json({}); return;
      }
      json({ status: 'complete', records: records.slice(Number(url.searchParams.get('cursor') ?? 0)), cursor: String(records.length) }); return;
    }
    if (url.pathname.startsWith('/blobs/')) {
      const id = url.pathname.slice('/blobs/'.length);
      if (request.method === 'POST') { const previous = blobs.get(id); if (previous && !previous.equals(body)) { response.writeHead(409); response.end('{}'); return; } blobs.set(id, body); json({}); return; }
      const bytes = blobs.get(id); if (!bytes) { response.writeHead(404); response.end(); return; }
      response.end(bytes); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const launch = async (client: Client) => {
    client.app = await electron.launch({ args: [root, `--user-data-dir=${client.profile}`], cwd: root, env: { ...process.env, GEODE_HEADLESS: '1' } });
    client.page = await client.app.firstWindow();
    await client.page.waitForFunction(id => (window as any).app?.sync?.listProviders().some((value: any) => value.id === id), providerId);
    expect(await client.page.evaluate(() => (window as any).app.pluginManager.getLoadError('immutable-fixture') ?? null)).toBeNull();
  };
  const addClient = async (name: string, seed = false) => {
    const base = path.join(directory, name); const vault = path.join(base, 'vault'); const profile = path.join(base, 'profile');
    const plugin = path.join(vault, '.geode/plugins/immutable-fixture'); await fs.mkdir(plugin, { recursive: true }); await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ id: 'immutable-fixture', name: 'Synthetic immutable fixture', version: '1.0.0', minAppVersion: '0.1.0', author: 'Geode', description: 'Loopback-only integration fixture' }));
    await fs.writeFile(path.join(plugin, 'main.js'), `
      const { Plugin, requestUrl } = require('geode');
      module.exports.default = class extends Plugin { onload() {
        const call = async (path, signal, body) => { const response = await requestUrl({ url: ${JSON.stringify(endpoint)} + path, method: body === undefined ? 'GET' : 'POST', headers: { 'x-fixture-client': ${JSON.stringify(name)} }, body, throw: false, signal }); if (response.status !== 200) throw new Error('Synthetic remote unavailable'); return response; };
        this.registerSyncProvider({ id: ${JSON.stringify(providerId)}, name: 'Synthetic immutable remote', protocol: 'append-only-history-v1', capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
          discover: async signal => (await call('/vaults', signal)).json,
          createVault: async (input, signal) => (await call('/vaults', signal, JSON.stringify(input))).json,
          open: async () => ({
            scan: async (cursor, signal) => (await call('/records?cursor=' + encodeURIComponent(cursor ?? '0'), signal)).json,
            putBlob: async (input, signal) => { await call('/blobs/' + input.operationId, signal, input.data); return { id: input.operationId, sha256: input.sha256, size: input.size }; },
            readBlob: async (ref, signal) => (await call('/blobs/' + ref.id, signal)).arrayBuffer,
            appendRecord: async (record, signal) => { await call('/records', signal, JSON.stringify(record)); }, close: async () => {},
          }),
        });
      } };
    `);
    await fs.writeFile(path.join(vault, '.geode/plugins.json'), JSON.stringify(['immutable-fixture']));
    await fs.writeFile(path.join(profile, 'geode.json'), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
    if (seed) { await fs.writeFile(path.join(vault, 'Note.md'), '# Synthetic note\ninitial'); await fs.writeFile(path.join(vault, 'Image.png'), Buffer.from([0, 255, 17, 3])); await fs.mkdir(path.join(vault, 'Empty')); }
    const client: Client = { name, directory: base, vault, profile }; clients.push(client); await launch(client); return client;
  };
  return { addClient, records, requests, offline, loseNextRecord: (client: string) => { loseRecordFor = client; },
    restart: async (client: Client, beforeLaunch: () => void = () => {}) => {
      await client.app?.close(); client.app = undefined; beforeLaunch(); await launch(client);
      try { await client.page!.waitForFunction(id => (window as any).app.sync.getActiveProvider()?.id === id, providerId, { timeout: 5000 }); }
      catch { throw new Error('Restart state: ' + JSON.stringify(await client.page!.evaluate(async () => { const app = (window as any).app; return { active: app.sync.getActiveProvider(), status: app.sync.getStatus(), binding: await app.host.deviceState.read('sync-history-binding/' + app.vault.root) }; }))); }
    },
    close: async () => { for (const client of clients.reverse()) await client.app?.close().catch(() => {}); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

async function run(client: Client, approve = false) {
  return client.page!.evaluate(async approve => { const sync = (window as any).app.sync; await sync.cancel(); await sync.preview(); return sync.run({ approvePreview: approve }); }, approve);
}
async function join(client: Client) {
  await client.page!.evaluate(async id => { const sync = (window as any).app.sync; await sync.activate(id); const roots = await sync.discoverVaults(); await sync.joinVault(roots[0]); }, providerId);
}
async function setup(client: Client) {
  await client.page!.evaluate(async id => { const sync = (window as any).app.sync; await sync.activate(id); await sync.createVault('Synthetic shared vault'); }, providerId);
}
const text = async (client: Client) => fs.readFile(path.join(client.vault, 'Note.md'), 'utf8').catch(() => 'MISSING');

test('independent clients approve, converge binary and folders, auto-publish edits, and reconstruct a third profile', async () => {
  test.setTimeout(180000); const remote = await fixture();
  try {
    const a = await remote.addClient('a', true); await setup(a);
    const preview = await a.page!.evaluate(() => (window as any).app.sync.preview());
    expect(preview.requiresApproval).toBe(true); expect(remote.records).toHaveLength(0);
    await run(a, true);
    const b = await remote.addClient('b'); await join(b); await run(b, true);
    await expect.poll(() => text(b)).toBe('# Synthetic note\ninitial');
    expect([...await fs.readFile(path.join(b.vault, 'Image.png'))]).toEqual([0, 255, 17, 3]);
    expect((await fs.stat(path.join(b.vault, 'Empty'))).isDirectory()).toBe(true);
    expect(remote.records.some(record => record.namespace === 'portable-config')).toBe(true);
    await b.page!.evaluate(async () => { const app = (window as any).app; await app.openFile(app.vault.getFileByPath('Note.md')); });
    await a.page!.evaluate(async () => { const app = (window as any).app; await app.openFile(app.vault.getFileByPath('Note.md')); const editor = app.workspace.activeLeaf.view.editor; editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '# Synthetic automatic edit' } }); });
    await expect.poll(() => remote.records.filter(record => record.location.name === 'Note.md').length, { timeout: 20000 }).toBe(2);
    await run(b); expect(await text(b)).toBe('# Synthetic automatic edit');
    await expect.poll(() => b.page!.evaluate(() => (window as any).app.workspace.activeLeaf.view.getText())).toBe('# Synthetic automatic edit');
    await a.page!.evaluate(async () => { const app = (window as any).app; const config = await app.host.config.read('app') ?? {}; await app.host.config.write('app', { ...config, readableLineLength: false }); });
    await run(a); await run(b);
    expect(await b.page!.evaluate(async () => (await (window as any).app.host.config.read('app')).readableLineLength)).toBe(false);
    const c = await remote.addClient('c'); await join(c); await run(c, true);
    expect(await text(c)).toBe('# Synthetic automatic edit');
    expect([...await fs.readFile(path.join(c.vault, 'Image.png'))]).toEqual([0, 255, 17, 3]);
    expect((await fs.stat(path.join(c.vault, 'Empty'))).isDirectory()).toBe(true);
    expect(remote.records.some(record => record.deleted)).toBe(false);
    expect(await c.page!.evaluate(() => (window as any).app.sync.getHistoryDetails())).toMatchObject({ conflicts: [], blocked: [], pending: 0 });
    expect(await c.page!.evaluate(async () => (await (window as any).app.host.config.read('app')).readableLineLength)).toBe(false);
  } finally { await remote.close(); }
});

test('offline concurrent edits remain explicit and an interrupted committed publication survives restart', async () => {
  test.setTimeout(180000); const remote = await fixture();
  try {
    const a = await remote.addClient('a', true); await setup(a); await run(a, true);
    const b = await remote.addClient('b'); await join(b); await run(b, true);
    await a.page!.evaluate(() => (window as any).app.sync.cancel()); await b.page!.evaluate(() => (window as any).app.sync.cancel());
    remote.offline.add('a'); remote.offline.add('b');
    await fs.writeFile(path.join(a.vault, 'Note.md'), 'offline version A'); await fs.writeFile(path.join(b.vault, 'Note.md'), 'offline version B');
    remote.offline.delete('a'); await run(a); remote.offline.delete('b'); await run(b);
    const conflicts = await b.page!.evaluate(() => (window as any).app.sync.getHistoryDetails().conflicts);
    expect(conflicts.some((conflict: any) => conflict.path === 'Note.md')).toBe(true);
    expect(await text(a)).toBe('offline version A'); expect(await text(b)).toBe('offline version B');
    await b.page!.evaluate(async () => { const sync = (window as any).app.sync; const conflict = sync.getHistoryDetails().conflicts.find((item: any) => item.path === 'Note.md'); await sync.resolveHistoryConflict({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'current' } }); });
    await run(a); expect(await text(a)).toBe('offline version B');
    await a.page!.evaluate(() => (window as any).app.sync.cancel()); await b.page!.evaluate(() => (window as any).app.sync.cancel());
    await fs.writeFile(path.join(a.vault, 'Note.md'), 'interrupted but committed'); remote.loseNextRecord('a');
    await expect(run(a)).rejects.toThrow();
    const count = remote.records.filter(record => record.location.name === 'Note.md').length;
    await remote.restart(a, () => remote.offline.delete('a'));
    await expect.poll(() => a.page!.evaluate(() => (window as any).app.sync.getStatus()), { timeout: 10000 }).toMatchObject({ state: 'idle', conflicts: 0 });
    await run(b);
    expect(await text(a)).toBe('interrupted but committed'); expect(await text(b)).toBe('interrupted but committed');
    expect(remote.records.filter(record => record.location.name === 'Note.md')).toHaveLength(count);
  } finally { await remote.close(); }
});

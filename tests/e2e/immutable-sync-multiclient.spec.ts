import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  SYNC_CONFLICT_BANNER_MESSAGE,
  SYNC_CONFLICT_CANCEL_LABEL,
  SYNC_CONFLICT_COMPARE_LABEL,
  SYNC_CONFLICT_DIALOG_SUBTITLE,
  SYNC_CONFLICT_DIALOG_TITLE,
  SYNC_CONFLICT_KEEP_LOCAL_LABEL,
  SYNC_CONFLICT_LOADING_TEXT,
  SYNC_CONFLICT_LOCAL_PANEL_TITLE,
  SYNC_CONFLICT_REMOTE_PANEL_TITLE,
  SYNC_CONFLICT_USE_REMOTE_LABEL,
  describeComparisonBlocker,
} from '../../src/renderer/sync/conflict-presentation';

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
  return { addClient, records, blobs, requests, offline, loseNextRecord: (client: string) => { loseRecordFor = client; },
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

/* ------------------------------------------------------------------ *
 * Conflict UX                                                         *
 * ------------------------------------------------------------------ */

const OFFLINE_TEXT = { a: 'offline version A', b: 'offline version B', c: 'offline version C' } as const;

/**
 * Three independent clients edit the same note while offline, then publish in
 * turn. Each publishes against the shared baseline, so `Note.md` ends with
 * three divergent heads — the case a flat "local vs remote" comparison cannot
 * describe, and the reason the dialog has a selector rather than one pane.
 *
 * `Image.png` diverges on two of them at the same time, giving a genuine
 * non-comparable (binary) conflict to assert the Settings fallback against
 * without standing the whole fixture up twice.
 */
async function threeWayConflict(remote: Awaited<ReturnType<typeof fixture>>) {
  const a = await remote.addClient('a', true); await setup(a); await run(a, true);
  const b = await remote.addClient('b'); await join(b); await run(b, true);
  const c = await remote.addClient('c'); await join(c); await run(c, true);
  const clients = [a, b, c];
  for (const client of clients) await client.page!.evaluate(() => (window as any).app.sync.cancel());
  for (const client of clients) remote.offline.add(client.name);
  await fs.writeFile(path.join(a.vault, 'Note.md'), OFFLINE_TEXT.a);
  await fs.writeFile(path.join(b.vault, 'Note.md'), OFFLINE_TEXT.b);
  await fs.writeFile(path.join(c.vault, 'Note.md'), OFFLINE_TEXT.c);
  await fs.writeFile(path.join(a.vault, 'Image.png'), Buffer.from([1, 1, 1, 1]));
  await fs.writeFile(path.join(b.vault, 'Image.png'), Buffer.from([2, 2, 2, 2]));
  for (const client of clients) { remote.offline.delete(client.name); await run(client); }
  return { a, b, c, clients };
}

/** The conflict sync state is actually offering for one path, or null. */
const conflictFor = (client: Client, target: string) => client.page!.evaluate(
  path => ((window as any).app.sync.getHistoryDetails()?.conflicts ?? []).find((item: any) => item.path === path) ?? null,
  target,
);

/** Opens `relative` in a brand-new split so every pane stays simultaneously visible. */
const openInSplit = (client: Client, relative: string, reading = false) => client.page!.evaluate(async ({ relative, reading }) => {
  const app = (window as any).app;
  const leaf = app.workspace.getLeaf('split');
  await app.openFileInLeaf(leaf, app.vault.getFileByPath(relative));
  if (reading) await leaf.view.toggleMode();
}, { relative, reading });

test('a three-way content conflict banners every pane showing the note, including reading mode, and no others', async () => {
  test.setTimeout(240000); const remote = await fixture();
  try {
    const { c } = await threeWayConflict(remote);
    const page = c.page!;
    const conflict = await conflictFor(c, 'Note.md');
    expect(conflict).not.toBeNull();
    // More than two heads: the whole reason the dialog needs a version selector.
    expect(conflict!.heads).toHaveLength(3);

    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.vault.create('Calm.md', 'no conflict here');
      await app.openFile(app.vault.getFileByPath('Note.md'), false);
    });

    const banners = page.locator('.sync-conflict-banner');
    await expect(banners).toHaveCount(1);
    await expect(banners.first()).toBeVisible();
    await expect(banners.first().locator('.sync-conflict-banner-message')).toHaveText(SYNC_CONFLICT_BANNER_MESSAGE);
    await expect(banners.first().getByRole('button', { name: SYNC_CONFLICT_COMPARE_LABEL, exact: true })).toBeVisible();

    // Advisory, not blocking: the sync banner alone must never make the note read-only.
    expect(await page.evaluate(() => {
      const content = document.querySelector('.markdown-source-view .cm-content') as HTMLElement;
      return { editable: content.getAttribute('contenteditable'), readonly: content.getAttribute('aria-readonly') };
    })).toEqual({ editable: 'true', readonly: null });

    // A second pane on the same note, in reading mode, is flagged too.
    await openInSplit(c, 'Note.md', true);
    await expect(banners).toHaveCount(2);
    const readingPane = page.locator('.markdown-view-body').nth(1);
    await expect(readingPane.locator('.markdown-reading-view')).toBeVisible();
    await expect(readingPane.locator('.markdown-source-view')).toBeHidden();
    for (let index = 0; index < 2; index++) await expect(banners.nth(index)).toBeVisible();

    // A pane showing an unconflicted note gets nothing.
    await openInSplit(c, 'Calm.md');
    await expect(banners).toHaveCount(2);
    expect(await page.evaluate(() => {
      const app = (window as any).app;
      const flagged: Array<[string, number]> = [];
      app.workspace.iterateLeaves((leaf: any) => {
        // Exactly the panes the banner controller reconciles: sidebar views
        // (outline, backlinks, comments) also carry `file`, and must be ignored.
        if (typeof leaf.view?.presentSyncConflict === 'function' && leaf.view.file) {
          flagged.push([leaf.view.file.path, leaf.view.containerEl.querySelectorAll('.sync-conflict-banner').length]);
        }
      });
      return flagged;
    })).toEqual([['Note.md', 1], ['Note.md', 1], ['Calm.md', 0]]);
  } finally { await remote.close(); }
});

test('Compare & resolve shows every head read-only, and cancelling publishes nothing', async ({}, info) => {
  test.setTimeout(240000); const remote = await fixture();
  try {
    const { a, b, c, clients } = await threeWayConflict(remote);
    const page = c.page!;
    const conflict = (await conflictFor(c, 'Note.md'))!;
    expect(conflict.heads).toHaveLength(3);

    /** The exact bytes the fixture holds for one head, so panel text is asserted against, not sampled. */
    const headText = (recordId: string) => {
      const record = remote.records.find((item: any) => item.recordId === recordId)!;
      return remote.blobs.get(record.blob.id)!.toString('utf8');
    };
    expect(new Set(conflict.heads.map(headText))).toEqual(new Set(Object.values(OFFLINE_TEXT)));

    /** Everything a cancelled comparison must leave untouched. */
    const observable = async () => ({
      records: remote.records.length,
      noteRecords: remote.records.filter((record: any) => record.location.name === 'Note.md').length,
      blobs: remote.blobs.size,
      text: { a: await text(a), b: await text(b), c: await text(c) },
      conflicts: await Promise.all(clients.map(client => client.page!.evaluate(() =>
        ((window as any).app.sync.getHistoryDetails()?.conflicts ?? []).map((item: any) => `${item.path}:${[...item.heads].sort().join(',')}`).sort()))),
    });

    await page.evaluate(async () => { const app = (window as any).app; await app.openFile(app.vault.getFileByPath('Note.md'), false); });
    const opener = page.locator('.sync-conflict-banner .sync-conflict-banner-action');
    await expect(opener).toBeVisible();


    const theme = async (name: 'light' | 'dark') => {
      await page.evaluate(value => (window as any).app.setTheme(value), name === 'dark' ? 'obsidian' : 'moonstone');
      await expect.poll(() => page.evaluate(value => document.body.classList.contains(value), `theme-${name}`)).toBe(true);
    };
    const shoot = async (slug: string) => {
      for (const name of ['light', 'dark'] as const) {
        await theme(name);
        for (const [label, size] of [['narrow', { width: 760, height: 820 }], ['wide', { width: 1440, height: 1000 }]] as const) {
          await page.setViewportSize(size);
          await page.screenshot({ path: info.outputPath(`${slug}-${name}-${label}.png`) });
        }
      }
      await theme('light');
      await page.setViewportSize({ width: 1440, height: 1000 });
    };
    await shoot('conflict-banner');

    const before = await observable();
    await opener.click();

    const dialog = page.locator('.modal.sync-conflict-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.locator('.sync-conflict-title')).toHaveText(SYNC_CONFLICT_DIALOG_TITLE);
    await expect(dialog.locator('.sync-conflict-subtitle')).toHaveText(SYNC_CONFLICT_DIALOG_SUBTITLE);

    const panels = dialog.locator('.sync-conflict-panel');
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0).locator('.sync-conflict-panel-title')).toHaveText(SYNC_CONFLICT_LOCAL_PANEL_TITLE);
    await expect(panels.nth(1).locator('.sync-conflict-panel-title')).toHaveText(SYNC_CONFLICT_REMOTE_PANEL_TITLE);
    const localText = panels.nth(0).locator('.sync-conflict-panel-text');
    const remoteText = panels.nth(1).locator('.sync-conflict-panel-text');
    await expect(localText).toHaveText(OFFLINE_TEXT.c);
    // Read-only on both sides: no editor, no contenteditable, just text.
    await expect(localText).toHaveAttribute('aria-readonly', 'true');
    await expect(remoteText).toHaveAttribute('aria-readonly', 'true');

    // The selector spans EVERY head — three of them — with opaque device labels.
    const select = dialog.locator('select.sync-conflict-version-select');
    await expect(select).toBeEnabled();
    const options = select.locator('option');
    await expect(options).toHaveCount(3);
    expect(await options.evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))).toEqual(conflict.heads);
    const labels = await options.evaluateAll(nodes => nodes.map(node => node.textContent ?? ''));
    for (const label of labels) expect(label).toMatch(/^Device [0-9A-F]{4}( · version [0-9A-F]{4})?$/);
    expect(new Set(labels).size).toBe(3);
    // No names, no clocks, no implied ordering.
    expect(labels.join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|newest|latest|newer|older|ago|recent/i);

    await shoot('conflict-dialog');
    await page.setViewportSize({ width: 760, height: 820 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(select).toBeVisible();
    await expect(dialog.getByRole('button', { name: SYNC_CONFLICT_USE_REMOTE_LABEL, exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Each head renders its own content, not a collapsed or auto-picked one.
    for (const head of conflict.heads) {
      await select.selectOption(head);
      await expect(remoteText).toHaveText(headText(head));
    }

    // Focus trap: Tab cycles the dialog's own controls and never escapes.
    const focusId = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return 'none';
      if (el.classList.contains('sync-conflict-version-select')) return 'select';
      if (el.classList.contains('sync-conflict-banner-action')) return 'opener';
      if (el.classList.contains('sync-conflict-modal')) return 'modal';
      return el.tagName === 'BUTTON' ? `button:${el.textContent}` : el.tagName.toLowerCase();
    });
    const insideDialog = () => page.evaluate(() => Boolean(document.querySelector('.sync-conflict-modal')?.contains(document.activeElement)));
    const forward: string[] = [];
    const contained: boolean[] = [];
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press('Tab');
      contained.push(await insideDialog());
      forward.push(await focusId());
    }
    // Tab never escapes to the note behind the dialog, and wraps at the end
    // instead of running off it. Which controls are in the ring depends on what
    // the comparison managed to enable, so the trap is asserted as a property
    // rather than as one fixed order.
    expect(contained).toEqual([true, true, true, true, true, true]);
    expect(forward.slice(1)).toContain(forward[0]);
    expect(forward).not.toContain('opener');
    expect(forward).not.toContain('none');
    expect(forward.some(id => id.startsWith('button:') || id === 'select')).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await insideDialog()).toBe(true);

    // Escape dismisses and hands focus back to whatever opened the dialog.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await focusId()).toBe('opener');
    await expect(page.locator('.sync-conflict-banner')).toHaveCount(1);

    // Reopen and leave through Cancel; neither exit may publish anything.
    await opener.click();
    await expect(dialog.locator('select.sync-conflict-version-select')).toBeEnabled();
    await dialog.getByRole('button', { name: SYNC_CONFLICT_CANCEL_LABEL, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await focusId()).toBe('opener');
    await expect(page.locator('.sync-conflict-banner')).toHaveCount(1);
    expect(await observable()).toEqual(before);
  } finally { await remote.close(); }
});

/**
 * Regression guard for a live defect.
 *
 * `ConflictCompareModal.load()` issues its two panel reads concurrently
 * (`Promise.all([loadLocal(), loadSelected()])`), but `readHistoryConflictText`
 * routes through `SyncService.withController`, whose single-owner guard rejects
 * any second caller outright. `settled()` only waits for work that was already
 * in flight when it was called, so two reads started in the same tick both see
 * a free slot and the loser throws "Sync already running or disconnecting".
 *
 * `load()` treats that as terminal: the synced panel stays on "Loading…" and
 * BOTH resolutions are disabled, so the dialog opens unusable with no recovery
 * but closing. Whether the modal trips it is timing-dependent, but the unsafe
 * concurrency underneath is deterministic — which is what this asserts.
 */
test('the compare dialog opens usable, never racing its own two panel reads', async () => {
  test.setTimeout(240000); const remote = await fixture();
  try {
    const { c } = await threeWayConflict(remote);
    const page = c.page!;
    const conflict = (await conflictFor(c, 'Note.md'))!;

    /**
     * The service REFUSES concurrent comparison reads by design: a comparison
     * takes the history controller's single-owner slot, and abort/session/lease
     * are single-slot fields on SyncService, so admitting a second controller
     * would corrupt a live sync. Sequential reads are the supported shape.
     * The dialog's obligation is therefore never to ASK for concurrency —
     * asserting the service tolerates it would demand a property we
     * deliberately rejected.
     */
    const service = await page.evaluate(async entityId => {
      const sync = (window as any).app.sync;
      const read = async () => { try { await sync.readHistoryConflictText(entityId, { kind: 'current' }); return 'ok'; } catch (error) { return (error as Error).message; } };
      return { sequential: [await read(), await read()] };
    }, conflict.entityId);
    expect(service.sequential).toEqual(['ok', 'ok']);

    await page.evaluate(async () => { const app = (window as any).app; await app.openFile(app.vault.getFileByPath('Note.md'), false); });
    await page.locator('.sync-conflict-banner .sync-conflict-banner-action').click();
    const dialog = page.locator('.sync-conflict-modal');
    await expect(dialog).toBeVisible();

    // Regression: load() once issued both panel reads in the same tick, the
    // loser hit the single-owner guard, and the dialog opened permanently dead
    // — both panels stuck on the loading placeholder with both actions
    // disabled. Every panel must hold real text and no error may show.
    const panels = dialog.locator('.sync-conflict-panel-text');
    await expect(panels).toHaveCount(2);
    for (const index of [0, 1]) {
      await expect(panels.nth(index)).not.toHaveText(SYNC_CONFLICT_LOADING_TEXT);
      await expect(panels.nth(index)).not.toBeEmpty();
    }
    await expect(dialog.locator('.sync-conflict-message')).toBeHidden();
    await expect(dialog.getByRole('button', { name: SYNC_CONFLICT_KEEP_LOCAL_LABEL })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: SYNC_CONFLICT_USE_REMOTE_LABEL })).toBeEnabled();

    // Switching version re-reads through the same serialized chain.
    const select = dialog.locator('.sync-conflict-version-select');
    const shown = await select.inputValue();
    const others = conflict.heads.filter((head: string) => head !== shown);
    await select.selectOption(others[0]);
    await expect(panels.nth(1)).not.toHaveText(SYNC_CONFLICT_LOADING_TEXT);
    await expect(dialog.locator('.sync-conflict-message')).toBeHidden();
  } finally { await remote.close(); }
});

test('each resolution publishes and clears the banner in every pane', async () => {
  test.setTimeout(240000); const remote = await fixture();
  try {
    const { a, c, clients } = await threeWayConflict(remote);
    const page = c.page!;
    await page.evaluate(async () => { const app = (window as any).app; await app.openFile(app.vault.getFileByPath('Note.md'), false); });
    await openInSplit(c, 'Note.md', true);
    const banners = page.locator('.sync-conflict-banner');
    await expect(banners).toHaveCount(2);

    /**
     * Drives the REAL dialog: opens it from the banner and clicks the actual
     * footer button, so the reviewed-hash guard, the stale-head recheck and the
     * autosave settle all run exactly as they do for a user. Calling the sync
     * API directly would skip the whole surface this feature adds.
     */
    const resolveAs = async (choice: { kind: 'current' } | { kind: 'version'; recordId: string }) => {
      await page.locator('.sync-conflict-banner .sync-conflict-banner-action').first().click();
      const dialog = page.locator('.sync-conflict-modal');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.sync-conflict-panel-text').first()).not.toHaveText(SYNC_CONFLICT_LOADING_TEXT);
      if (choice.kind === 'version') await dialog.locator('.sync-conflict-version-select').selectOption(choice.recordId);
      const label = choice.kind === 'current' ? SYNC_CONFLICT_KEEP_LOCAL_LABEL : SYNC_CONFLICT_USE_REMOTE_LABEL;
      const action = dialog.getByRole('button', { name: label });
      await expect(action).toBeEnabled();
      await action.click();
      await expect(dialog).toHaveCount(0);
    };

    // "Keep this device's version" — local content wins, banner clears everywhere.
    await resolveAs({ kind: 'current' });
    await expect(banners).toHaveCount(0);
    expect(await text(c)).toBe(OFFLINE_TEXT.c);
    expect(await conflictFor(c, 'Note.md')).toBeNull();

    // Diverge again, this time between two clients, to exercise the other action.
    for (const client of clients) await client.page!.evaluate(() => (window as any).app.sync.cancel());
    for (const client of [a, c]) remote.offline.add(client.name);
    await fs.writeFile(path.join(a.vault, 'Note.md'), 'second round A');
    await fs.writeFile(path.join(c.vault, 'Note.md'), 'second round C');
    for (const client of [a, c]) { remote.offline.delete(client.name); await run(client); }
    await expect.poll(() => page.locator('.sync-conflict-banner').count()).toBe(2);

    // "Use selected synced version" — the chosen head's content lands locally.
    const remoteHead = await page.evaluate(() => {
      const sync = (window as any).app.sync;
      const conflict = sync.getHistoryDetails().conflicts.find((item: any) => item.path === 'Note.md');
      return conflict.heads as string[];
    });
    const chosen = remoteHead.find(head => remote.blobs.get(remote.records.find((item: any) => item.recordId === head)!.blob.id)!.toString('utf8') === 'second round A')!;
    expect(chosen).toBeTruthy();
    await resolveAs({ kind: 'version', recordId: chosen });
    await expect(banners).toHaveCount(0);
    await expect.poll(() => text(c)).toBe('second round A');
    expect(await conflictFor(c, 'Note.md')).toBeNull();
  } finally { await remote.close(); }
});

test('Settings compares a Markdown conflict and keeps the original workflow for a binary one', async () => {
  test.setTimeout(240000); const remote = await fixture();
  try {
    const { c } = await threeWayConflict(remote);
    const page = c.page!;
    await page.evaluate(() => (window as any).app.setting.openTabById('sync'));
    const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
    await expect(modal).toBeVisible();

    // Comparable Markdown conflict: the per-head buttons collapse into one action.
    const noteRow = modal.locator('.setting-item').filter({ has: page.getByText('Note.md', { exact: true }) });
    await expect(noteRow.getByRole('button', { name: SYNC_CONFLICT_COMPARE_LABEL, exact: true })).toBeVisible();
    await expect(noteRow.getByRole('button', { name: 'Keep local', exact: true })).toHaveCount(0);
    await expect(noteRow.getByRole('button', { name: /^Accept version / })).toHaveCount(0);
    await expect(noteRow.locator('.sync-conflict-fallback')).toHaveCount(0);

    // Binary conflict: no text comparison exists, so the original workflow stays
    // and the row says why.
    const imageRow = modal.locator('.setting-item').filter({ has: page.getByText('Image.png', { exact: true }) });
    await expect(imageRow.getByRole('button', { name: SYNC_CONFLICT_COMPARE_LABEL, exact: true })).toHaveCount(0);
    await expect(imageRow.getByRole('button', { name: 'Keep local', exact: true })).toBeVisible();
    await expect(imageRow.getByRole('button', { name: /^Accept version / })).toHaveCount(2);
    await expect(imageRow.locator('.sync-conflict-fallback')).toHaveText(describeComparisonBlocker('non-markdown'));

    // Both entry points reach the same dialog.
    await noteRow.getByRole('button', { name: SYNC_CONFLICT_COMPARE_LABEL, exact: true }).click();
    await expect(page.locator('.modal.sync-conflict-modal')).toBeVisible();
    await expect(page.locator('.modal.sync-conflict-modal .sync-conflict-title')).toHaveText(SYNC_CONFLICT_DIALOG_TITLE);
  } finally { await remote.close(); }
});

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

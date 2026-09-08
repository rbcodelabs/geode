import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const repoRoot = path.resolve(__dirname, '../..');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const canvasText = JSON.stringify({ nodes: [{ id: 'text', type: 'text', x: 0, y: 0, width: 220, height: 120, text: 'original' }], edges: [] });
const sourceText = '---\npriority: 1\n---\n\nOriginal source\n';

interface Fixture {
  app: ElectronApplication;
  first: Page;
  second: Page;
  vault: string;
  otherVault: string;
  apply(relative?: string, expected?: string, next?: string): Promise<unknown>;
}

async function isolated(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geode-sync-adversarial-'));
  const vault = path.join(directory, 'vault');
  const otherVault = path.join(directory, 'other-vault');
  const profile = path.join(directory, 'profile');
  for (const target of [vault, otherVault, profile]) fs.mkdirSync(target);
  fs.writeFileSync(path.join(vault, 'Note.md'), 'old');
  fs.writeFileSync(path.join(vault, 'Ideas.canvas'), canvasText);
  fs.writeFileSync(path.join(vault, 'Source.md'), sourceText);
  fs.writeFileSync(path.join(vault, 'Tasks.base'), 'views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n');
  fs.writeFileSync(path.join(otherVault, 'Note.md'), 'other-vault');
  fs.writeFileSync(path.join(profile, 'geode.json'), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot });
    const first = await app.firstWindow();
    await first.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    const ready = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, preload) => {
      const source = BrowserWindow.getAllWindows()[0];
      const peer = new BrowserWindow({ show: false, webPreferences: { preload, nodeIntegration: true, contextIsolation: false, sandbox: false } });
      void peer.loadURL(source.webContents.getURL());
    }, path.join(repoRoot, 'dist/preload.js'));
    const second = await ready;
    await second.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    const owner = await first.evaluate(() => (window as any).app.host.syncSafety.claimOwner());
    expect(owner).toBeTruthy();
    const apply = (relative = 'Note.md', expected = 'old', next = 'remote') => first.evaluate(({ owner, relative, expectedHash, next, operationId }) =>
      (window as any).app.host.syncSafety.apply(owner, { operationId, path: relative, expectedHash, kind: 'write', data: new TextEncoder().encode(next).buffer }),
    { owner, relative, expectedHash: hash(expected), next, operationId: randomUUID() });
    await run({ app, first, second, vault, otherVault, apply });
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function open(page: Page, relative = 'Note.md'): Promise<void> {
  await page.evaluate(async relative => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath(relative));
  }, relative);
}

async function gatePrepare(page: Page): Promise<void> {
  await page.evaluate(() => {
    const workspace = (window as any).app.workspace;
    const original = workspace.holdAutosave.bind(workspace);
    (window as any).guardOriginalHold = original;
    workspace.holdAutosave = async (token: string) => {
      const held = await original(token);
      (window as any).guardEntered = true;
      await new Promise<void>(resolve => { (window as any).guardContinue = resolve; });
      (window as any).guardFinished = true;
      return held;
    };
  });
}

test('dirty Canvas document blocks an incoming guarded write', async () => {
  await isolated(async ({ second, vault, apply }) => {
    await open(second, 'Ideas.canvas');
    await second.evaluate(() => {
      const view = (window as any).app.workspace.activeLeaf.view;
      // Hold the persistence edge while exercising the real Canvas editing UI.
      view.persist = async () => undefined;
    });
    const node = second.locator('.canvas-node[data-node-id="text"]');
    await node.dblclick();
    const editor = node.locator('.canvas-node-text-editor');
    await editor.fill('unsaved Canvas content');
    await editor.press('ControlOrMeta+Enter');
    expect(await second.evaluate(() => (window as any).app.workspace.activeLeaf.view.hasUnacknowledgedChanges())).toBe(true);
    await expect(apply('Ideas.canvas', canvasText, JSON.stringify({ nodes: [], edges: [] }))).rejects.toThrow(/Canvas|unsaved/i);
    expect(fs.readFileSync(path.join(vault, 'Ideas.canvas'), 'utf8')).toBe(canvasText);
    await expect.poll(() => second.evaluate(() => document.body.inert)).toBe(false);
  });
});

test('uncommitted Base source-cell draft blocks the underlying note write', async () => {
  await isolated(async ({ second, vault, apply }) => {
    await open(second, 'Tasks.base');
    const row = second.locator('.bases-data-row').filter({ hasText: 'Source.md' });
    await expect(row).toBeVisible();
    const headers = await second.locator('.bases-table thead th').allInnerTexts();
    const column = headers.indexOf('note.priority');
    expect(column).toBeGreaterThan(-1);
    const cell = row.locator('td.bases-cell').nth(column);
    await cell.dblclick();
    await cell.locator('.bases-cell-input').fill('9');
    expect(await second.evaluate(async () => Boolean(await (window as any).app.workspace.activeLeaf.view.getDirtySourceConflict('Source.md')))).toBe(true);
    await expect(apply('Source.md', sourceText, '---\npriority: 2\n---\nRemote source\n')).rejects.toThrow(/Base|unsaved/i);
    // Releasing the guard may commit the user's draft; it must never replace
    // it with the remote version that was rejected while the draft was dirty.
    await expect.poll(() => fs.readFileSync(path.join(vault, 'Source.md'), 'utf8')).toContain('priority: 9');
    expect(fs.readFileSync(path.join(vault, 'Source.md'), 'utf8')).toContain('Original source');
  });
});

test('prepare timeout releases holds even when the prepare callback completes late', async () => {
  await isolated(async ({ second, vault, apply }) => {
    await open(second);
    await gatePrepare(second);
    const attempted = apply();
    const rejected = expect(attempted).rejects.toThrow(/timed out/i);
    await second.waitForFunction(() => (window as any).guardEntered);
    await rejected;
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('old');
    await second.evaluate(() => (window as any).guardContinue());
    await second.waitForFunction(() => (window as any).guardFinished);
    await expect.poll(() => second.evaluate(() => ({ body: document.body.inert, suspended: (window as any).app.workspace.activeLeaf.view.vaultSwitching }))).toEqual({ body: false, suspended: false });
    await second.evaluate(() => { (window as any).app.workspace.holdAutosave = (window as any).guardOriginalHold; });
    await apply();
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('remote');
  });
});

test('peer window closing during prepare prevents the canonical mutation', async () => {
  await isolated(async ({ second, first, vault, apply }) => {
    await open(second);
    await gatePrepare(second);
    const attempted = apply();
    const rejected = expect(attempted).rejects.toThrow(/closed|changed|timed out/i);
    await second.waitForFunction(() => (window as any).guardEntered);
    await second.close();
    await rejected;
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('old');
    await expect.poll(() => first.evaluate(() => document.body.inert)).toBe(false);
  });
});

test('peer vault switch during prepare cannot mutate either vault', async () => {
  await isolated(async ({ second, vault, otherVault, apply }) => {
    await open(second);
    await gatePrepare(second);
    const attempted = apply();
    const rejected = expect(attempted).rejects.toThrow(/changed|timed out|released/i);
    await second.waitForFunction(() => (window as any).guardEntered);
    await second.evaluate(async target => { await (window as any).app.switchVaultInWindow(target); }, otherVault);
    await second.waitForFunction(target => (window as any).app?.vault?.root === target && Boolean((window as any).app?.workspace), otherVault);
    await rejected;
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(otherVault, 'Note.md'), 'utf8')).toBe('other-vault');
    expect(await second.evaluate(() => document.body.inert)).toBe(false);
  });
});

test('nested reconciliation does not release the outer sync autosave hold', async () => {
  await isolated(async ({ second, vault, apply }) => {
    await open(second);
    await gatePrepare(second);
    const attempted = apply();
    await second.waitForFunction(() => (window as any).guardEntered);
    await second.evaluate(() => (window as any).app.reconcileVault('manual'));
    expect(await second.evaluate(() => ({ body: document.body.inert, suspended: (window as any).app.workspace.activeLeaf.view.vaultSwitching }))).toEqual({ body: true, suspended: true });
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('old');
    await second.evaluate(() => (window as any).guardContinue());
    await attempted;
    await expect.poll(() => second.evaluate(() => (window as any).app.workspace.activeLeaf.view.vaultSwitching)).toBe(false);
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('remote');
  });
});

for (const failure of ['throw', 'timeout'] as const) {
  test(`${failure} during refresh leaves stale writers paused until recovery`, async () => {
    await isolated(async ({ second, vault, apply }) => {
      await open(second);
      await second.evaluate(failure => {
        const app = (window as any).app;
        (window as any).guardOriginalReconcile = app.reconcileVault.bind(app);
        // Suppress the fast watcher refresh to exercise the stale-writer boundary.
        app.handleExternalModify = async () => undefined;
        app.reconcileVault = async () => {
          (window as any).refreshEntered = true;
          if (failure === 'throw') throw new Error('Synthetic refresh failure');
          await new Promise<void>(resolve => { (window as any).refreshContinue = resolve; });
          await (window as any).guardOriginalReconcile('manual');
        };
      }, failure);
      await expect(apply()).rejects.toThrow(/refresh incomplete/i);
      if (failure === 'throw') await expect(apply('Note.md', 'remote')).rejects.toThrow(/refresh incomplete/i);
      expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('remote');
      expect(await second.evaluate(() => ({ body: document.body.inert, editor: (window as any).app.workspace.activeLeaf.view.containerEl.inert, suspended: (window as any).app.workspace.activeLeaf.view.vaultSwitching }))).toEqual({ body: false, editor: true, suspended: true });
      await second.evaluate(() => {
        const view = (window as any).app.workspace.activeLeaf.view;
        view.editor.dispatch({ changes: { from: 0, to: view.editor.state.doc.length, insert: 'queued stale edit' } });
      });
      // Past Markdown's documented 1000 ms autosave interval, a queued edit must
      // still not write while the failed-refresh hold is retained.
      await second.waitForTimeout(1200);
      expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('remote');
      await second.evaluate(async failure => {
        const app = (window as any).app;
        app.reconcileVault = (window as any).guardOriginalReconcile;
        if (failure === 'timeout') (window as any).refreshContinue();
        await app.reconcileVault('manual');
      }, failure);
      await expect.poll(() => second.evaluate(() => (window as any).app.workspace.activeLeaf.view.containerEl.inert)).toBe(false);
      expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('remote');
    });
  });
}

test('a rejected Canvas refresh cannot acknowledge sync or clear stale-writer protection', async () => {
  await isolated(async ({ second, apply }) => {
    await open(second, 'Ideas.canvas');
    await second.evaluate(() => {
      const app = (window as any).app, view = app.workspace.activeLeaf.view;
      app.vault.off('modify', view.onVaultModify);
      (window as any).originalAccept = view.acceptExternalText.bind(view);
      view.acceptExternalText = async () => { throw new Error('Synthetic Canvas refresh rejection'); };
    });
    await expect(apply('Ideas.canvas', canvasText, JSON.stringify({ nodes: [], edges: [] }))).rejects.toThrow(/refresh incomplete/i);
    expect(await second.evaluate(() => (window as any).app.workspace.activeLeaf.view.containerEl.inert)).toBe(true);
    await second.evaluate(async () => { const app = (window as any).app; app.workspace.activeLeaf.view.acceptExternalText = (window as any).originalAccept; await app.reconcileVault('manual'); });
    expect(await second.evaluate(() => (window as any).app.workspace.activeLeaf.view.containerEl.inert)).toBe(false);
  });
});

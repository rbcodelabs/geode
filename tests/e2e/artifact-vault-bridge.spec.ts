import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const TASKS_BASE = `filters:
  and:
    - 'status != "done"'
views:
  - type: table
    name: Main
    sort:
      - property: note.priority
        direction: ASC
    order:
      - file.name
      - note.status
      - note.priority
`;

function writeArtifact(root: string, id: string, permissions: Record<string, unknown>, script: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "artifact.json"), JSON.stringify({
    schemaVersion: 1, id, title: id, entry: "index.html", runtime: "static",
    createdByThreadId: "thread-e2e", viewport: { preset: "custom", width: 640, height: 400 },
    permissions: { network: "none", clipboard: false, ...permissions },
  }));
  fs.writeFileSync(path.join(root, "index.html"),
    `<!doctype html><title>${id}</title><main id="out">loading</main><script src="app.js"></script>`);
  fs.writeFileSync(path.join(root, "app.js"), script);
}

const LIVE_SCRIPT = `
const out = document.getElementById("out");
async function render() {
  const r = await window.geodeArtifact.query({ base: "Tasks.base", view: "Main" });
  out.textContent = r.error ? "ERR " + r.error.code : r.rows.map((row) => row.file.basename).join(",");
}
window.geodeArtifact.onChange(render);
window.probe = (request) => window.geodeArtifact.query(request);
render();
`;

test("vault-read artifacts query allowlisted Bases live; others get no bridge", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-artifact-vault-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(path.join(vaultPath, "Notes"), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, "Private"), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "Tasks.base"), TASKS_BASE);
  fs.writeFileSync(path.join(vaultPath, "Private", "Secret.base"), "views:\n  - type: table\n    name: Main\n    order: [file.name]\n");
  fs.writeFileSync(path.join(vaultPath, "Notes", "Alpha.md"), "---\nstatus: todo\npriority: 1\n---\n");
  fs.writeFileSync(path.join(vaultPath, "Notes", "Beta.md"), "---\nstatus: todo\npriority: 2\n---\n");
  fs.writeFileSync(path.join(vaultPath, "Notes", "Gamma.md"), "---\nstatus: done\npriority: 3\n---\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultPath], lastVault: vaultPath,
  }));

  const liveRoot = path.join(temp, "live");
  const plainRoot = path.join(temp, "plain");
  writeArtifact(liveRoot, "vault-live", { vault: "read", vaultAllowlist: ["Tasks.base"] }, LIVE_SCRIPT);
  writeArtifact(plainRoot, "vault-none", {}, `document.getElementById("out").textContent = typeof window.geodeArtifact;`);

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    // Make sure the vault index is populated before the guest asks.
    await window.waitForFunction(() => (window as any).app?.vault?.getFileByPath("Tasks.base"));
    await window.waitForFunction(() => (window as any).app?.vault?.getFileByPath("Notes/Alpha.md"));

    // --- artifact without the permission: no bridge at all
    await window.evaluate((root) => (window as any).app.openArtifact(root), plainRoot);
    const plain = window.locator('.artifact-view-frame[src="geode-artifact://vault-none/index.html"]');
    await expect(plain).toBeVisible();
    await expect.poll(() => plain.evaluate((g) => (g as any).executeJavaScript(`document.getElementById("out").textContent`)))
      .toBe("undefined");
    expect(await plain.evaluate((g) => (g as any).executeJavaScript(
      `({ api: typeof window.geodeArtifact, require: typeof require, ipc: typeof ipcRenderer, electron: typeof electron })`,
    ))).toEqual({ api: "undefined", require: "undefined", ipc: "undefined", electron: "undefined" });

    // --- artifact with vault read
    await window.evaluate((root) => (window as any).app.openArtifact(root), liveRoot);
    const live = window.locator('.artifact-view-frame[src="geode-artifact://vault-live/index.html"]');
    await expect(live).toBeVisible();
    const text = () => live.evaluate((g) => (g as any).executeJavaScript(`document.getElementById("out").textContent`));
    await expect.poll(text).toBe("Alpha,Beta");

    // exposed surface is exactly { query, onChange }; no Node / IPC leakage
    expect(await live.evaluate((g) => (g as any).executeJavaScript(
      `({ keys: Object.keys(window.geodeArtifact).sort(), require: typeof require, ipc: typeof ipcRenderer, process: typeof process })`,
    ))).toEqual({ keys: ["onChange", "query"], require: "undefined", ipc: "undefined", process: "undefined" });

    // out-of-allowlist and traversal requests are rejected as {error}
    const probe = (request: unknown) => live.evaluate(
      (g, req) => (g as any).executeJavaScript(`window.probe(${JSON.stringify(req)})`), request);
    expect(await probe({ base: "Private/Secret.base" })).toMatchObject({ error: { code: "not_allowed" } });
    expect(await probe({ base: "../Tasks.base" })).toMatchObject({ error: { code: "bad_request" } });
    // The preload forwards only base/view/limit, so an inline definition is dropped and cannot alter the query.
    const withInlineDef = await probe({ base: "Tasks.base", view: "Main", def: { views: [] } });
    expect(withInlineDef.rows.map((r: any) => r.file.path)).toEqual(["Notes/Alpha.md", "Notes/Beta.md"]);
    expect(await probe({ view: "Main", def: { views: [] } })).toMatchObject({ error: { code: "bad_request" } });
    const ok = await probe({ base: "Tasks.base", view: "Main" });
    expect(ok.rows.map((r: any) => r.file.path)).toEqual(["Notes/Alpha.md", "Notes/Beta.md"]);
    expect(ok.columns.map((c: any) => c.path)).toEqual(["file.name", "note.status", "note.priority"]);

    // live update: editing a note re-renders without reloading the guest
    await live.evaluate((g) => (g as any).executeJavaScript(`window.__marker = 1`));
    fs.writeFileSync(path.join(vaultPath, "Notes", "Gamma.md"), "---\nstatus: todo\npriority: 0\n---\n");
    await expect.poll(text, { timeout: 15_000 }).toBe("Gamma,Alpha,Beta");
    expect(await live.evaluate((g) => (g as any).executeJavaScript(`window.__marker`))).toBe(1);
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("manifest requesting vault read without an allowlist is rejected", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-artifact-vault-bad-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));
  const root = path.join(temp, "bad");
  writeArtifact(root, "vault-bad", { vault: "read" }, "");
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate((r) => (window as any).app.openArtifact(r), root);
    await expect(window.locator(".artifact-view-error")).toContainText("permissions.vaultAllowlist");
    await expect(window.locator(".artifact-view-frame")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

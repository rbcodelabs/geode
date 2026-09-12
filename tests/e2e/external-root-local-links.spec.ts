import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * End-to-end cover for clicking a local-file link that points into an attached
 * Project folder.
 *
 * The host used to compare such a path only against the vault root, so a file
 * inside a granted, read-only Project root was handed to the OS default
 * application. Reaching the identical file through the Projects tree opened it
 * in Geode's read-only viewer, so the same file behaved two different ways
 * depending on how it was reached.
 */
async function fixture() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geode-local-link-roots-e2e-")));
  const userData = path.join(base, "user-data");
  const vault = path.join(base, "vault");
  const project = path.join(base, "project");
  const unrelated = path.join(base, "unrelated");
  await Promise.all([userData, vault, project, unrelated].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(path.join(vault, "Welcome.md"), "# Vault note\n");
  await fs.writeFile(path.join(project, "note.md"), "# Project note\n");
  await fs.writeFile(path.join(unrelated, "outside.md"), "# Outside every root\n");
  await fs.writeFile(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
  return { app, window, base, project, unrelated, vault };
}

/** Record OS hand-offs so "opened externally" is observable, not inferred. */
async function trackShellOpens(app: Awaited<ReturnType<typeof fixture>>["app"]) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { shellOpens: string[] }).shellOpens = opened;
    shell.openPath = async (target: string) => {
      opened.push(target);
      return "";
    };
  });
}

const shellOpens = (app: Awaited<ReturnType<typeof fixture>>["app"]) =>
  app.evaluate(() => (globalThis as unknown as { shellOpens: string[] }).shellOpens);

test("a local-file link inside an attached Project root opens in the read-only viewer", async () => {
  const s = await fixture();
  try {
    await trackShellOpens(s.app);
    await s.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, s.project);

    await s.window.evaluate(async (suggestedPath) => {
      const roots = window.geode.externalRoots!;
      await roots.contribute([{ projectId: "project-a", label: "Test Project", suggestedPath }]);
      const attached = await roots.attach("project-a");
      if (attached?.state !== "bound") throw new Error("Expected attached project");
    }, s.project);

    const outcome = await s.window.evaluate(
      (target) => (window.app as unknown as {
        openLocalFileLink(href: string): Promise<string>;
      }).openLocalFileLink(target),
      path.join(s.project, "note.md")
    );

    expect(outcome).toBe("external-resource");
    // The read-only viewer is showing it, and the OS was never involved.
    expect(await shellOpens(s.app)).toEqual([]);
    const viewer = await s.window.evaluate(() =>
      window.app.workspace.getLeavesOfType("geode-external-source").length
    );
    expect(viewer).toBe(1);
    await expect(s.window.locator("pre.external-source-text code")).toContainText("# Project note");
    await expect(s.window.locator(".external-source-readonly")).toHaveText("Read-only · External source");
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});

test("a local-file link outside every root still goes to the OS", async () => {
  const s = await fixture();
  try {
    await trackShellOpens(s.app);
    const target = path.join(s.unrelated, "outside.md");

    const outcome = await s.window.evaluate(
      (href) => (window.app as unknown as {
        openLocalFileLink(href: string): Promise<string>;
      }).openLocalFileLink(href),
      target
    );

    expect(outcome).toBe("external");
    expect(await shellOpens(s.app)).toEqual([target]);
    expect(await s.window.evaluate(() =>
      window.app.workspace.getLeavesOfType("geode-external-source").length
    )).toBe(0);
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});

test("a local-file link inside the vault still opens as a vault note", async () => {
  const s = await fixture();
  try {
    await trackShellOpens(s.app);

    const outcome = await s.window.evaluate(
      (href) => (window.app as unknown as {
        openLocalFileLink(href: string): Promise<string>;
      }).openLocalFileLink(href),
      path.join(s.vault, "Welcome.md")
    );

    expect(outcome).toBe("vault");
    expect(await shellOpens(s.app)).toEqual([]);
    expect(await s.window.evaluate(() =>
      window.app.workspace.getActiveFile()?.path ?? null
    )).toBe("Welcome.md");
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});

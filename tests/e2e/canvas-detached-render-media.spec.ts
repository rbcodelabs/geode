import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { CanvasBackgroundLifetimes } from "./helpers/canvas-background-lifetimes";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Regression guard for Canvas media cards that render before their view is in
 * the document.
 *
 * Every Canvas open path (`App.mountDocumentInLeaf` and the workspace's
 * `restoreLeafView`) does `await view.setFile(file)` — which renders the whole
 * board — and only then `await leaf.setView(view)`, which attaches it. A media
 * card's `vault.readBinary` therefore races the attach, and when the read wins
 * (routine on a loaded machine) the load used to be discarded as if it were
 * stale, leaving the card blank forever because nothing re-renders afterwards.
 *
 * The test makes that race deterministic instead of load-dependent by holding
 * every `leaf.setView` for 250ms, which is far longer than a vault binary read
 * — so the first render always completes while detached.
 */
test("fills Canvas media cards rendered before the view is attached to the document", async ({}, info) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-detached-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-detached-user-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(path.join(vaultDir, "Photo.png"), png);
  fs.writeFileSync(path.join(vaultDir, "Unreadable.png"), png);
  fs.copyFileSync(path.join(__dirname, "fixtures/media/canvas-silence.mp3"), path.join(vaultDir, "Sound.mp3"));
  fs.writeFileSync(path.join(vaultDir, "Close.md"), "# Close Canvas\n");
  fs.writeFileSync(path.join(vaultDir, "Detached.canvas"), JSON.stringify({
    nodes: [
      { id: "image", type: "file", x: 0, y: 0, width: 320, height: 220, file: "Photo.png" },
      { id: "audio", type: "file", x: 380, y: 0, width: 320, height: 160, file: "Sound.mp3" },
      { id: "broken", type: "file", x: 760, y: 0, width: 320, height: 220, file: "Unreadable.png" },
    ],
    edges: [],
  }));
  const canvasBefore = fs.readFileSync(path.join(vaultDir, "Detached.canvas"), "utf8");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const resources = new CanvasBackgroundLifetimes(window, "__detachedBlobTracker", info);
    const errors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() === "error" && !resources.isExpectedProbeError(msg.text(), msg.location().url)) errors.push(msg.text());
    });
    window.on("pageerror", (error) => errors.push(String(error)));

    await expect.poll(() => window.evaluate(() => (window as any).app?.workspace?.layoutReady ?? false)).toBe(true);
    await resources.install();
    await window.evaluate(() => {
      const application = (window as any).app;
      // One vault file is unreadable, so the read-failure branch is exercised
      // in the same detached window as the success branch.
      const readBinary = application.vault.readBinary.bind(application.vault);
      application.vault.readBinary = async (file: { path: string }) => {
        if (file.path === "Unreadable.png") throw new Error("simulated unreadable file");
        return readBinary(file);
      };

      // Hold every leaf's view attachment well past the vault read, so the
      // Canvas always completes its first render while detached.
      let sample: any = null;
      application.workspace.iterateLeaves((leaf: any) => { sample ??= leaf; });
      const leafProto = Object.getPrototypeOf(sample);
      const setView = leafProto.setView;
      leafProto.setView = async function (this: unknown, view: unknown) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return setView.call(this, view);
      };
    });

    await window.locator('.nav-file-title[data-path="Detached.canvas"]').click();
    const view = window.locator(".canvas-view");

    // The view really did render before it was attached.
    await expect(view.locator('.canvas-node[data-node-id="image"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="audio"] audio.canvas-node-media')).toHaveAttribute("src", /^blob:/);

    // An unreadable file is never silently blank either — it shows the fallback.
    await expect(view.locator('.canvas-node[data-node-id="broken"] .canvas-node-file-fallback')).toHaveText("Unreadable.png");
    await expect(view.locator('.canvas-node[data-node-id="broken"] img.canvas-node-media')).toHaveCount(0);

    // Unchanged media retain the actual connected node and source URL across
    // an unrelated transient card. Both PNG and valid MP3 have native positives.
    const imageResource = await resources.captureMedia(view, "image", "image");
    const audioResource = await resources.captureMedia(view, "audio", "audio");
    await resources.expectLiveExactly([imageResource, audioResource]);
    await view.getByRole("button", { name: "Add text card" }).click();
    await view.locator(".canvas-node-text-editor").press("Escape");
    await resources.expectRetained(view, "image", imageResource);
    await resources.expectRetained(view, "audio", audioResource);
    await resources.expectLiveExactly([imageResource, audioResource]);

    // The retained cards and failed-read fallback remain visible.
    await expect(view.locator('.canvas-node[data-node-id="image"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="audio"] audio.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="broken"] .canvas-node-file-fallback')).toHaveText("Unreadable.png");

    await window.locator('.nav-file-title[data-path="Close.md"]').click();
    await resources.expectRetired([imageResource, audioResource]);
    await resources.expectAllRetired();

    expect(fs.readFileSync(path.join(vaultDir, "Detached.canvas"), "utf8")).toBe(canvasBefore);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

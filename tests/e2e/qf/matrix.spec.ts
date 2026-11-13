import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { BASIC_ARTIFACT } from "../helpers/artifact-picker-fixtures";
import {
  BUY, VARIANT, THREAD, attachArtifact, clickAt, commentsPath, commentsToggle, ev, diag, guestEval, launch, openArtifact, pickAndSubmit, pickToggle, popStatus, popover,
  readComments, sends, si, sidecarFiles, writeDesignArtifact, guestKey,
} from "./lib";

/** Cross-version negotiation matrix (design 1.1), observed on the real artifacts. */
const V2 = VARIANT === "new-new";
const GEODE_VERSIONS = VARIANT === "old-new" ? [1] : [1, 2];

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) info.annotations.push({ type: "diag", description: await diag() });
});

test.describe(`matrix ${VARIANT}`, () => {
  test.skip(!process.env.QF_PLUGIN, "needs QF_PLUGIN: a built Design plugin directory");
  test.setTimeout(150_000);

  test("QF-M01 Pick offered; Pin and the comments toggle only on new Geode + new plugin", async () => {
    const s = await launch();
    try {
      const root = writeDesignArtifact(s.vault, "hand", BASIC_ARTIFACT);
      await attachArtifact(s.window, root, BASIC_ARTIFACT);
      await openArtifact(s.window, root);
      const w = s.window;
      const versions = await w.evaluate(() => (window as any).app.artifactFeedback?.contractVersions ?? null);
      ev("M01.versions", versions);
      expect(versions).toEqual(GEODE_VERSIONS);
      await pickToggle(w).click();
      await clickAt(s.app, BUY.x, BUY.y);
      await expect(popover(w)).toBeVisible({ timeout: 15_000 });
      await expect(popover(w).getByRole("button", { name: "Send", exact: true })).toBeVisible();
      if (V2) {
        await expect(popover(w).getByRole("button", { name: "Pin", exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(commentsToggle(w)).toBeVisible({ timeout: 15_000 });
      } else {
        await w.waitForTimeout(3000); // give a late comments.list every chance to appear
        await expect(popover(w).getByRole("button", { name: "Pin", exact: true })).toBeHidden();
        await expect(commentsToggle(w)).toBeHidden();
      }
    } finally { await s.cleanup(); }
  });

  test("QF-M02 Send now works exactly as before (one threads.send, fenced prompt, sidecar written, no comments.json, no reload)", async () => {
    const s = await launch();
    try {
      const w = s.window;
      const root = writeDesignArtifact(s.vault, "hand", BASIC_ARTIFACT);
      await attachArtifact(w, root, BASIC_ARTIFACT);
      await openArtifact(w, root);
      await expect.poll(() => guestEval<string>(w, "window.__marker"), { timeout: 15_000 }).toMatch(/^loaded-/);
      const marker = await guestEval<string>(w, "window.__marker");
      const status = await pickAndSubmit(s, BUY, "Make the button larger.", "send");
      expect(status).toMatch(/Sent/);
      const calls = await sends(w);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.id).toBe(THREAD);
      expect(calls[0]!.prompt).toContain("Make the button larger.");
      expect(calls[0]!.prompt).toMatch(/BEGIN-[A-Za-z0-9_-]+/);
      ev("M02.prompt", calls[0]!.prompt.slice(0, 400));
      const files = sidecarFiles(root);
      ev("M02.files", files);
      expect(files.some((f) => /selections\/.*\.json$/.test(f))).toBe(true);
      expect(fs.existsSync(commentsPath(root))).toBe(false);
      await w.waitForTimeout(1500);
      expect(await guestEval<string>(w, "window.__marker")).toBe(marker); // sidecar writes did not reload the artifact
    } finally { await s.cleanup(); }
  });

  test("QF-M03 the plugin writes nothing v2 (no comments.json, no plugin data) unless a v2 registration succeeded", async () => {
    const s = await launch();
    try {
      const w = s.window;
      const root = writeDesignArtifact(s.vault, "hand", BASIC_ARTIFACT);
      await attachArtifact(w, root, BASIC_ARTIFACT);
      await openArtifact(w, root);
      await w.waitForTimeout(4000);
      const data = path.join(s.vault, ".geode", "plugins", "threads-design", "data.json");
      ev("M03.data", fs.existsSync(data));
      if (V2) return; // on the v2 path the install key is created lazily; checked in the flow spec
      expect(fs.existsSync(commentsPath(root))).toBe(false);
      expect(fs.existsSync(data)).toBe(false);
      await pickAndSubmit(s, BUY, "x", "send");
      expect(fs.existsSync(commentsPath(root))).toBe(false);
      expect(fs.existsSync(data)).toBe(false);
      // nothing anywhere in the vault is named comments.json
      const all = fs.readdirSync(s.vault, { recursive: true } as any).map(String);
      expect(all.filter((f) => /comments\.json/.test(f))).toEqual([]);
    } finally { await s.cleanup(); }
  });

  test("QF-M04 the .threads-design folder is never served to the page (404) and sidecar writes do not reload it", async () => {
    const s = await launch();
    try {
      const w = s.window;
      const root = writeDesignArtifact(s.vault, "hand", BASIC_ARTIFACT);
      await attachArtifact(w, root, BASIC_ARTIFACT);
      await openArtifact(w, root);
      await pickAndSubmit(s, BUY, "serve me", "send");
      const file = sidecarFiles(root).find((f) => /selections\/.*\.json$/.test(f))!;
      const statuses = await guestEval<number[]>(w, `Promise.all(${JSON.stringify([`/.threads-design/${file}`, "/.threads-design/comments.json", "/.threads-design/", "/%2e%74hreads-design/comments.json"])}.map((u) => fetch(u).then((r) => r.status).catch(() => -1)))`);
      ev("M04.statuses", statuses);
      for (const st of statuses) expect([404, 403, -1]).toContain(st);
    } finally { await s.cleanup(); }
  });

  test("QF-M05 Ctrl+Shift+Enter in the popover: Pin when Pin is offered, otherwise the global 'Toggle focus on active pane' command still fires (no send)", async () => {
    const s = await launch();
    try {
      const w = s.window;
      const root = writeDesignArtifact(s.vault, "hand", BASIC_ARTIFACT);
      await attachArtifact(w, root, BASIC_ARTIFACT);
      await openArtifact(w, root);
      await w.evaluate(() => { const ws = (window as any).app.workspace; const orig = ws.toggleFocusPane.bind(ws); (window as any).__tfp = 0; ws.toggleFocusPane = (...a: unknown[]) => { (window as any).__tfp++; return orig(...a); }; });
      await pickToggle(w).click();
      await clickAt(s.app, BUY.x, BUY.y);
      await expect(popover(w)).toBeVisible({ timeout: 15_000 });
      if (V2) await expect(popover(w).getByRole("button", { name: "Pin", exact: true })).toBeVisible({ timeout: 20_000 });
      await popover(w).locator("textarea").click();
      await w.keyboard.type("keyboard global command");
      await w.keyboard.press("ControlOrMeta+Shift+Enter");
      await w.waitForTimeout(2500);
      const info = { st: (await popStatus(w).textContent()) ?? "", sends: (await sends(w)).length, comments: readComments(root)?.comments?.length ?? null, tfp: await w.evaluate(() => (window as any).__tfp as number) };
      if (V2) expect(info, "Pin offered: the combo pins").toMatchObject({ sends: 0, comments: 1, tfp: 0 });
      else expect(info, "v1 popover: the global command fires and nothing is sent or written").toMatchObject({ sends: 0, comments: null, tfp: 1 });
      if (V2) expect(info.st).toMatch(/Pinned/);
      await guestKey(s.app, "Escape");
    } finally { await s.cleanup(); }
  });
});

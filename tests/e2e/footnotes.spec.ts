import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const NOTE = `# Footnotes

Alpha[^1] and beta[^note] and again[^1], plus inline^[An inline note] and dangling[^ghost] and \`code[^1]\`.

\`\`\`
fenced[^1]
[^1]: not a definition
\`\`\`

[^1]: First footnote.
[^note]: Second footnote
    with a continuation.
`;

test("renders footnotes in Live Preview and Reading view", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-footnote-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-footnote-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Footnotes.md"), NOTE);
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();

    await window.locator('.nav-file-title[data-path="Footnotes.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    // --- Live Preview -------------------------------------------------
    const refs = window.locator(".cm-content sup.cm-footnote-ref");
    // [^1], [^note], [^1] again, and the inline footnote. Not the dangling
    // reference, the code span, or the fenced block.
    await expect(refs).toHaveCount(4);
    await expect(refs).toHaveText(["[1]", "[2]", "[1]", "[3]"]);
    await expect(window.locator(".cm-content")).toContainText("dangling[^ghost]");
    await expect(window.locator(".cm-content")).toContainText("code[^1]");
    await expect(window.locator(".cm-content")).toContainText("fenced[^1]");
    // Hover text previews the definition.
    await expect(refs.first()).toHaveAttribute("title", "First footnote.");

    // Definition lines (both lines of the second one) are styled; their
    // `[^id]:` labels become numbers while the cursor is elsewhere.
    const defLines = window.locator(".cm-content .cm-footnote-definition");
    await expect(defLines).toHaveCount(3);
    await expect(window.locator(".cm-content .cm-footnote-label")).toHaveText(["[1]:", "[2]:"]);

    // Clicking a reference jumps to its definition, and the cursor being in
    // it shows that definition's raw source.
    await refs.first().click();
    await expect(defLines.first()).toContainText("[^1]: First footnote.");
    await expect(window.locator(".cm-content .cm-footnote-label")).toHaveText(["[2]:"]);

    // --- Reading view ---------------------------------------------------
    await window.locator('[title="Toggle reading view (Cmd/Ctrl+E)"]').click();
    const reading = window.locator(".markdown-reading-view");
    await expect(reading).toBeVisible();

    const readingRefs = reading.locator("sup.footnote-ref");
    await expect(readingRefs).toHaveCount(4);
    await expect(readingRefs).toHaveText(["[1]", "[2]", "[1]", "[3]"]);

    const items = reading.locator("section.footnotes li.footnote-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("First footnote.");
    await expect(items.nth(1)).toContainText("Second footnote");
    await expect(items.nth(1)).toContainText("with a continuation.");
    await expect(items.nth(2)).toContainText("An inline note");
    // [^1] is referenced twice, so its entry links back to both.
    await expect(items.nth(0).locator("a.footnote-backref")).toHaveCount(2);
    await expect(items.nth(1).locator("a.footnote-backref")).toHaveCount(1);

    // Definition lines do not leak into the body; code stays literal; an
    // undefined reference stays literal.
    await expect(reading).not.toContainText("[^1]: First footnote.");
    await expect(reading).toContainText("dangling[^ghost]");
    await expect(reading.locator("p code")).toHaveText("code[^1]");
    await expect(reading.locator("pre code")).toContainText("fenced[^1]");
    await expect(reading.locator("pre code")).toContainText("[^1]: not a definition");

    const firstLink = reading.locator("#fnref-1 a.footnote-link");
    await expect(firstLink).toHaveAttribute("title", "First footnote.");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Enough filler that the definition is below the fold, so "clicking a
// reference navigates to its definition" is observable as a scroll.
const FILLER = Array.from({ length: 70 }, (_v, i) => `Filler paragraph ${i + 1}.`).join("\n\n");

test("Reading view footnote links scroll to the definition and back", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-footnote-scroll-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-footnote-scroll-ud-"));
  fs.writeFileSync(
    path.join(vaultDir, "Long.md"),
    `Top claim[^1].\n\n${FILLER}\n\n[^1]: The definition at the bottom.\n`
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.locator('.nav-file-title[data-path="Long.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();
    await window.locator('[title="Toggle reading view (Cmd/Ctrl+E)"]').click();
    const reading = window.locator(".markdown-reading-view");
    await expect(reading).toBeVisible();

    const item = reading.locator("#fn-1");
    await expect(item).toContainText("The definition at the bottom.");
    await expect(item).not.toBeInViewport();
    await reading.locator("#fnref-1 a.footnote-link").click();
    await expect(item).toBeInViewport();
    await item.locator("a.footnote-backref").click();
    await expect(reading.locator("#fnref-1")).toBeInViewport();
    await expect(item).not.toBeInViewport();
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

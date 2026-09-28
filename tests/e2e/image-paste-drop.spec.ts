import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

// A real 1x1 PNG, so the Live Preview <img> actually decodes.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

const NOTE = "# Images\n\nBefore\n\nAfter\n";

/** Dispatch a paste event carrying files (and optional text) at the focused editor. */
async function pasteInto(window: Page, files: { name: string; type: string }[], text = "") {
  return window.evaluate(
    ({ files, text, b64 }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      if (text) dt.setData("text/plain", text);
      const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(".cm-content")!.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { files, text, b64: PNG_BASE64 },
  );
}

/** Dispatch a file drop onto the middle of the editor line containing `lineText`. */
async function dropOnLine(window: Page, lineText: string, files: { name: string; type: string }[]) {
  return window.evaluate(
    ({ lineText, files, b64 }) => {
      const line = [...document.querySelectorAll(".cm-line")].find((el) => el.textContent?.includes(lineText))!;
      const rect = line.getBoundingClientRect();
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.right - 2, clientY: rect.top + rect.height / 2 };
      const over = new DragEvent("dragover", init);
      line.dispatchEvent(over);
      const drop = new DragEvent("drop", init);
      line.dispatchEvent(drop);
      return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
    },
    { lineText, files, b64: PNG_BASE64 },
  );
}

test("pasting or dropping an image saves a vault attachment and embeds it in the note", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-attach-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-attach-ud-"));
  const notePath = path.join(vaultDir, "Note.md");
  fs.writeFileSync(notePath, NOTE);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.locator('.nav-file-title[data-path="Note.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    const note = () => fs.readFileSync(notePath, "utf8");
    const attachments = () => fs.readdirSync(vaultDir).filter((name) => name.endsWith(".png")).sort();

    // --- Paste: a screenshot-style clipboard image lands at the cursor -----
    await window.locator(".cm-line", { hasText: "Before" }).click();
    await window.keyboard.press("End");
    expect(await pasteInto(window, [{ name: "image.png", type: "image/png" }])).toBe(true);

    await expect.poll(() => attachments().length).toBe(1);
    const pasted = attachments()[0];
    expect(pasted).toMatch(/^Pasted image \d{14}\.png$/);
    expect(fs.readFileSync(path.join(vaultDir, pasted)).equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
    await expect.poll(note).toContain(`Before![[${pasted}]]`);

    // The embed resolves and renders once the cursor leaves its line.
    await window.locator(".cm-line", { hasText: "After" }).click();
    const embeddedImage = window.locator(".cm-content img.internal-embed");
    await expect(embeddedImage).toHaveCount(1);
    await expect.poll(() => embeddedImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    // --- Drop: a file from disk keeps its name and lands at the drop point --
    const first = await dropOnLine(window, "After", [{ name: "photo.png", type: "image/png" }]);
    expect(first).toEqual({ overPrevented: true, dropPrevented: true });
    await expect.poll(() => attachments()).toContain("photo.png");
    await expect.poll(note).toContain("After![[photo.png]]");

    // --- Collision: the same name again never overwrites -------------------
    await dropOnLine(window, "After", [{ name: "photo.png", type: "image/png" }]);
    await expect.poll(() => attachments()).toContain("photo 1.png");
    await expect.poll(note).toContain("![[photo 1.png]]");

    // --- Not ours: a non-image drop writes no attachment and a text+image paste is left to the default paste ---
    const before = attachments();
    await dropOnLine(window, "Images", [{ name: "doc.pdf", type: "application/pdf" }]);
    await pasteInto(window, [{ name: "image.png", type: "image/png" }], "plain text");
    // CodeMirror pastes the text; no attachment is written for the preview image.
    await expect.poll(note).toContain("plain text");
    expect(attachments()).toEqual(before);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "modal-parity");

/**
 * Parity guarantees for Geode's modal chrome.
 *
 * Four DOM classes that the plugin-API Modal has always emitted — `.modal-bg`,
 * `.modal-title`, `.modal-close-button`, `.modal-button-container` — used to
 * carry no CSS rules at all. The visible consequences, each pinned below:
 *
 *   - `.modal-bg` stayed in normal flow, so it became a second flex item in
 *     `.modal-container`'s centering row and shoved the modal off-centre.
 *   - `.modal-close-button` was a zero-size invisible div: not clickable.
 *   - `.modal-button-container` had no gap or alignment.
 *   - `.modal` itself had no padding (the padding model was inverted, with
 *     `.modal-content` pinning `padding: 0`), so dialogs rendered flush
 *     against their own border.
 */

const scratch: string[] = [];

function seedVault(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-modal-parity-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-modal-parity-ud-"));
  scratch.push(vaultDir, userDataDir);
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "modal-parity-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const name of ["manifest.json", "main.js"]) {
    fs.copyFileSync(path.join(fixtureDir, name), path.join(pluginDir, name));
  }
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Modal parity\n");
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "plugins.json"),
    JSON.stringify(["modal-parity-probe"]),
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  return { vaultDir, userDataDir };
}

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  const { userDataDir } = seedVault();
  app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  window = await app.firstWindow();
  await expect
    .poll(() => window.evaluate(() => typeof (window as any).__modalParityProbe?.open))
    .toBe("function");
  await window.setViewportSize({ width: 1100, height: 700 });
});

test.afterAll(async () => {
  await app?.close();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Opens the probe modal, asserting it actually mounted. */
async function openProbe(opts: { emptyTitle?: boolean } = {}) {
  await window.evaluate((o) => (window as any).__modalParityProbe.open(o), opts);
  await expect(window.locator(".modal-container .modal")).toBeVisible();
}

async function closeProbe() {
  await window.evaluate(() => (window as any).__modalParityProbe.last?.close());
  await expect(window.locator(".modal-container")).toHaveCount(0);
}

test("the modal box carries its own padding", async () => {
  await openProbe();
  const box = await window.locator(".modal").evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      top: cs.paddingTop,
      right: cs.paddingRight,
      bottom: cs.paddingBottom,
      left: cs.paddingLeft,
      contentPadding: getComputedStyle(el.querySelector(".modal-content")!).padding,
    };
  });
  // --size-4-4. The old model had this on neither element.
  expect(box).toMatchObject({
    top: "16px",
    right: "16px",
    bottom: "16px",
    left: "16px",
  });
  // Padding belongs to `.modal` alone — the content column must not re-add it.
  expect(box.contentPadding).toBe("0px");
  await closeProbe();
});

test("the scrim is taken out of flow and covers the whole viewport", async () => {
  await openProbe();
  const bg = await window.locator(".modal-bg").evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      position: cs.position,
      hasCover: cs.backgroundColor !== "rgba(0, 0, 0, 0)",
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  expect(bg.position).toBe("absolute");
  expect(bg.hasCover).toBe(true);
  expect(bg.rect).toEqual({ x: 0, y: 0, w: bg.viewport.w, h: bg.viewport.h });
  await closeProbe();
});

test("the modal sits centred in the viewport, not pushed aside by the scrim", async () => {
  await openProbe();
  const centring = await window.locator(".modal").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      modalCentreX: r.x + r.width / 2,
      viewportCentreX: window.innerWidth / 2,
    };
  });
  // The off-centre bug: an in-flow `.modal-bg` consumed half the centering
  // row, so the modal centred against the leftover space instead.
  expect(Math.abs(centring.modalCentreX - centring.viewportCentreX)).toBeLessThanOrEqual(1);
  await closeProbe();
});

test("the close button is visible and hit-testable at its own centre", async () => {
  await openProbe();
  const hit = await window.locator(".modal-close-button").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const atCentre = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      width: r.width,
      height: r.height,
      // The element under its own centre point must be the button itself (or
      // its ::before glyph's host) — not whatever is painted behind it.
      selfIsOnTop: el === atCentre || el.contains(atCentre),
    };
  });
  expect(hit.width).toBeGreaterThan(0);
  expect(hit.height).toBeGreaterThan(0);
  expect(hit.selfIsOnTop).toBe(true);

  // And it actually dismisses, via a real click at that point.
  await window.locator(".modal-close-button").click();
  await expect(window.locator(".modal-container")).toHaveCount(0);
});

test("the button container aligns its actions in a row", async () => {
  await openProbe();
  const row = await window.locator(".modal-button-container").evaluate((el) => {
    const cs = getComputedStyle(el);
    const [cancel, save] = [...el.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    return {
      display: cs.display,
      justifyContent: cs.justifyContent,
      gap: cs.columnGap,
      sameRow: Math.abs(cancel.y - save.y) < 1,
      gapBetween: save.x - (cancel.x + cancel.width),
      // Buttons must end flush with the content column's trailing edge.
      trailingSlack: el.getBoundingClientRect().right - save.right,
    };
  });
  expect(row.display).toBe("flex");
  expect(row.justifyContent).toBe("flex-end");
  expect(row.gap).toBe("8px");
  expect(row.sameRow).toBe(true);
  expect(row.gapBetween).toBeCloseTo(8, 0);
  expect(row.trailingSlack).toBeCloseTo(0, 0);
  await closeProbe();
});

test("the title is styled, and collapses when a modal renders its own heading", async () => {
  await openProbe();
  const titled = await window.locator(".modal-title").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { display: cs.display, fontSize: cs.fontSize, fontWeight: cs.fontWeight, text: el.textContent };
  });
  expect(titled.text).toBe("Parity probe");
  expect(titled.display).not.toBe("none");
  expect(titled.fontSize).toBe("20px"); // --font-ui-large
  expect(titled.fontWeight).toBe("600"); // --font-semibold
  await closeProbe();

  // Most in-app modals render their own <h2> inside `.modal-content` and never
  // set a title. The empty slot must not reserve vertical space above them.
  await openProbe({ emptyTitle: true });
  const empty = await window
    .locator(".modal-title")
    .evaluate((el) => ({ display: getComputedStyle(el).display, height: el.getBoundingClientRect().height }));
  expect(empty.display).toBe("none");
  expect(empty.height).toBe(0);
  await closeProbe();
});

// Obsidian documents these on its "Modal" and "Dialog" CSS-variable reference
// pages. Themes set them expecting the app to read them back, so each must
// resolve to something — an undefined custom property silently drops whatever
// declaration consumes it.
const DOCUMENTED_MODAL_VARS = [
  "--modal-background",
  "--modal-width",
  "--modal-height",
  "--modal-max-width",
  "--modal-max-height",
  "--modal-max-width-narrow",
  "--modal-border-width",
  "--modal-border-color",
  "--modal-radius",
  "--modal-community-sidebar-width",
];
const DOCUMENTED_DIALOG_VARS = ["--dialog-width", "--dialog-max-width", "--dialog-max-height"];

test("the documented Modal and Dialog CSS variables all resolve", async () => {
  const resolved = await window.evaluate((names) => {
    const cs = getComputedStyle(document.body);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  }, [...DOCUMENTED_MODAL_VARS, ...DOCUMENTED_DIALOG_VARS]);
  for (const [name, value] of Object.entries(resolved)) {
    expect(value, `${name} must resolve to a value`).not.toBe("");
  }
});

test("the dialog sizing variables are the ones actually driving the modal box", async () => {
  await openProbe();
  const sizing = await window.locator(".modal").evaluate((el) => {
    const root = getComputedStyle(document.body);
    const cs = getComputedStyle(el);
    return {
      width: cs.width,
      declaredWidth: root.getPropertyValue("--dialog-width").trim(),
      maxWidth: cs.maxWidth,
      maxHeight: cs.maxHeight,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  expect(sizing.declaredWidth).toBe("560px");
  expect(sizing.width).toBe("560px");
  // 80vw / 85vh of the 1100x700 viewport this suite pins.
  expect(sizing.maxWidth).toBe(`${sizing.viewport.w * 0.8}px`);
  expect(sizing.maxHeight).toBe(`${sizing.viewport.h * 0.85}px`);
  await closeProbe();
});

test("Escape dismisses a plugin-API modal", async () => {
  await openProbe();
  // The plugin-facing Modal had no key handling at all, so Escape did nothing
  // — a modal could only be dismissed by clicking.
  await window.keyboard.press("Escape");
  await expect(window.locator(".modal-container")).toHaveCount(0);
});

test("clicking the scrim dismisses the modal", async () => {
  await openProbe();
  await window.locator(".modal-bg").click({ position: { x: 5, y: 5 } });
  await expect(window.locator(".modal-container")).toHaveCount(0);
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import moment from "moment";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "calendar");

/**
 * Find the day cell for a given day-of-month, scoped to the currently
 * *displayed* month (`.day:not(.adjacent-month)` excludes the leading/
 * trailing days from neighboring months the grid pads with). The vendored
 * plugin doesn't render a `data-date` attribute on day cells (checked
 * against the real fixture — see tests/fixtures/plugins/calendar/README.md),
 * so this locates by the day cell's own visible day-of-month text (its
 * first child text node — the rest of the cell is a dot-container div) and
 * tags the match with a throwaway attribute for a stable Playwright locator.
 */
async function locateDayCell(window: Page, dayOfMonth: number): Promise<Locator> {
  const marker = `e2e-day-${dayOfMonth}`;
  const found = await window.evaluate(
    ({ dayOfMonth, marker }) => {
      const cells = Array.from(document.querySelectorAll(".day:not(.adjacent-month)"));
      for (const cell of cells) {
        const label = cell.childNodes[0]?.textContent?.trim();
        if (label === String(dayOfMonth)) {
          cell.setAttribute("data-e2e-marker", marker);
          return true;
        }
      }
      return false;
    },
    { dayOfMonth, marker }
  );
  if (!found) throw new Error(`No non-adjacent-month day cell found for day-of-month ${dayOfMonth}`);
  return window.locator(`[data-e2e-marker="${marker}"]`);
}

test("real Calendar plugin sees existing daily notes and opens (not recreates) them", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-calendar-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-calendar-e2e-"));

  // Three distinct days within the *currently displayed* month (today's
  // real month — Calendar opens showing it), chosen from day-of-month 1-4
  // (every month has at least 28 days, so all four are always valid) and
  // deliberately NOT computed via Date.now()-relative day math (which gets
  // flaky near month boundaries, e.g. "yesterday" rolling into the prior
  // month). `today` itself is identified unambiguously via Calendar's own
  // `.today` CSS class rather than by day-of-month text.
  const today = moment();
  const [existingDayOfMonth, noNoteDayOfMonth] = [1, 2, 3, 4].filter((d) => d !== today.date());
  const existingDay = today.clone().date(existingDayOfMonth);
  const noNoteDay = today.clone().date(noNoteDayOfMonth);

  fs.writeFileSync(
    path.join(vaultDir, `${today.format("YYYY-MM-DD")}.md`),
    "# Today's note\n\nWritten before boot.\n"
  );
  fs.writeFileSync(
    path.join(vaultDir, `${existingDay.format("YYYY-MM-DD")}.md`),
    "# Existing note\n\nAlso written before boot.\n"
  );

  // Install the vendored fixture directly to disk and enable it, mirroring
  // tests/e2e/plugin-smoke.spec.ts — no fake GitHub server needed.
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "calendar");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(fixtureDir, "manifest.json"), path.join(pluginDir, "manifest.json"));
  fs.copyFileSync(path.join(fixtureDir, "main.js"), path.join(pluginDir, "main.js"));
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["calendar"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const consoleErrors: string[] = [];

  try {
    const window = await app.firstWindow();
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    // Calendar's own onload() defers opening its view to the workspace
    // "layout-ready" boundary, docking a right-sidebar leaf automatically
    // (no ribbon icon in this release — verified against the real fixture).
    // Its icon then appears in the sidebar icon bar; click it to reveal the
    // panel, same as a user would.
    const calendarIcon = window.locator(
      '.workspace-sidebar.mod-right .workspace-tab-header[aria-label="Calendar"]'
    );
    await expect(calendarIcon).toBeVisible({ timeout: 15000 });
    await calendarIcon.click();

    const calendarPane = window.locator(".workspace-sidebar.mod-right .sidebar-content");
    await expect(calendarPane.locator(".day").first()).toBeVisible();

    // --- 1. Vault visibility -------------------------------------------
    // Days with an existing note are marked with Calendar's own "has-note"
    // class (confirmed against the real fixture's streakSource, which
    // toggles it based on whether a matching file was found via
    // app.internalPlugins.getPluginById("daily-notes") + Vault.recurseChildren
    // over the daily-notes folder). Before this fix, the internalPlugins
    // stub always returned null, so this never lit up for ANY day.
    const todayCell = calendarPane.locator(".day.today");
    await expect(todayCell).toBeVisible();
    await expect(todayCell).toHaveClass(/has-note/);

    await expect((await locateDayCell(window, existingDay.date()))).toHaveClass(/has-note/);
    await expect((await locateDayCell(window, noNoteDay.date()))).not.toHaveClass(/has-note/);

    // --- 2. Open, don't recreate -----------------------------------------
    // Clicking a day with an existing note opens that exact file directly
    // (openOrCreateDailyNote finds it via the daily-notes index and calls
    // leaf.openFile) with no "create new note?" confirmation modal. Before
    // this fix, Calendar could never find ANY existing file (internalPlugins
    // stub) and would always fall into the create path here instead.
    // Re-located fresh (rather than reusing the locator from step 1): the
    // calendar re-renders its day grid on file-open/vault events, which can
    // replace earlier DOM nodes (and the throwaway marker attribute on them).
    await (await locateDayCell(window, existingDay.date())).click();
    await expect(window.locator(".modal-container")).toHaveCount(0);
    await expect(window.locator(".cm-editor")).toBeVisible();
    const openedText = await window.locator(".cm-editor").innerText();
    expect(openedText).toContain("Existing note");
    expect(openedText).toContain("Also written before boot");

    // --- 3. Control: creation still works for a day with no note --------
    // Proves the fix didn't regress creation: Calendar's own
    // "Confirm before creating new note" setting defaults to true, so
    // clicking a note-less day still shows its own confirmation modal
    // (a real UX behavior of the plugin, distinct from the bug) before
    // creating the file.
    await (await locateDayCell(window, noNoteDay.date())).click();
    const modal = window.locator(".modal-container");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("New Daily Note");
    await modal.getByRole("button", { name: "Create" }).click();
    await expect(modal).toHaveCount(0);
    const expectedPath = path.join(vaultDir, `${noNoteDay.format("YYYY-MM-DD")}.md`);
    await expect.poll(() => fs.existsSync(expectedPath)).toBe(true);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

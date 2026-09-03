import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

// A real, valid woff2 taken from a declared dependency rather than a synthetic
// blob, so a successful load is genuine proof the browser parsed and accepted
// the embedded face — not just that the request slipped past CSP.
const FONT_BASE64 = fs
  .readFileSync(path.join(repoRoot, "node_modules/lucide-static/font/lucide.woff2"))
  .toString("base64");

// A theme carrying its own font the only way it can: inlined into theme.css.
// ThemeManager injects that CSS as a <style> element, so a relative url() would
// resolve against the app bundle, and community install only ever writes
// manifest.json/main.js/styles.css/theme.css — a .woff2 cannot travel alongside.
const THEME_CSS = `
@font-face {
  font-family: "GeodeEmbeddedFont";
  src: url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");
  font-display: block;
}
body { --font-text-theme: "GeodeEmbeddedFont"; }
`;

test("a community theme can ship its own font as a data: URI", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-theme-font-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-theme-font-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const themeDir = path.join(vaultDir, ".geode", "themes", "Embedded");
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, "theme.css"), THEME_CSS);
  fs.writeFileSync(
    path.join(themeDir, "manifest.json"),
    JSON.stringify({ name: "Embedded", version: "1.0.0", minAppVersion: "0.1.0", author: "test" })
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();

    // Capture every CSP refusal the renderer reports from here on.
    await window.evaluate(() => {
      const violations: { blockedURI: string; effectiveDirective: string }[] = [];
      (window as unknown as Record<string, unknown>).__cspViolations = violations;
      document.addEventListener("securitypolicyviolation", (event) => {
        violations.push({
          blockedURI: event.blockedURI,
          effectiveDirective: event.effectiveDirective || event.violatedDirective,
        });
      });
    });

    // Apply the theme, then force the embedded face to actually load.
    const statuses = await window.evaluate(async () => {
      await (window as any).app.themeManager.apply("Embedded");
      const faces = await document.fonts.load('16px "GeodeEmbeddedFont"');
      return faces.map((face) => face.status);
    });
    await expect(window.locator("style#geode-community-theme")).toHaveCount(1);
    expect(statuses).toEqual(["loaded"]);

    const afterTheme = await window.evaluate(
      () => (window as unknown as { __cspViolations: { blockedURI: string }[] }).__cspViolations
    );
    expect(afterTheme).toEqual([]);

    // Control: the same @font-face served remotely is still refused. This
    // proves the listener above is wired up (so the empty result is meaningful)
    // and that font-src was widened to data: only — never to an external host.
    const remoteViolations = await window.evaluate(async () => {
      const style = document.createElement("style");
      style.textContent =
        '@font-face { font-family: "GeodeRemoteFont"; src: url(https://fonts.example.invalid/f.woff2) format("woff2"); }';
      document.head.appendChild(style);
      try {
        await document.fonts.load('16px "GeodeRemoteFont"');
      } catch {
        // A refused fetch may surface as a rejection; the violation event is the oracle.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (window as unknown as { __cspViolations: { blockedURI: string; effectiveDirective: string }[] })
        .__cspViolations;
    });
    expect(remoteViolations.length).toBeGreaterThan(0);
    expect(remoteViolations.some((violation) => violation.effectiveDirective === "font-src")).toBe(true);
    expect(remoteViolations.some((violation) => violation.blockedURI.includes("fonts.example.invalid"))).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

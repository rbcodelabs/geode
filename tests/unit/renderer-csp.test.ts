import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer's Content-Security-Policy is a static meta tag in each app
 * shell, so nothing else in the codebase can assert on it at runtime. These
 * tests pin it: they prove themes can embed fonts as data: URIs, and — the
 * part worth having — that the policy stays narrow if someone later reaches
 * for a font CDN or a wildcard instead.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

/** Both app shells (desktop Electron window, Capacitor mobile webview). */
const SHELLS = ["src/renderer/index.html", "src/renderer/mobile.html"] as const;

function readCsp(relPath: string): string {
  const html = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  if (!match) throw new Error(`no Content-Security-Policy meta tag in ${relPath}`);
  return match[1];
}

function parseDirectives(csp: string): Map<string, string[]> {
  const entries = csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/);
      return [name, sources] as const;
    });
  return new Map(entries);
}

describe.each(SHELLS)("renderer CSP (%s)", (shell) => {
  const directives = parseDirectives(readCsp(shell));

  it("lets a community theme supply its own font as a data: URI", () => {
    // Without an explicit font-src, fonts fall back to default-src 'self',
    // which excludes data: — and a data: URI is a theme's only option, since
    // ThemeManager injects theme.css as text (breaking relative url()) and
    // community install refuses to write font files (ALLOWED_FILES).
    expect(directives.get("font-src")).toEqual(["'self'", "data:"]);
  });

  it("keeps every directive on a same-origin footing", () => {
    expect(directives.get("default-src")).toEqual(["'self'"]);
    // No remote origins anywhere: a data: font is deliberately narrower than
    // permitting a font CDN, and this policy should not drift into one.
    for (const [name, sources] of directives) {
      for (const source of sources) {
        expect(source, `${name} must not allow a remote origin`).not.toMatch(/^https?:\/\//);
        expect(source, `${name} must not allow a wildcard`).not.toContain("*");
      }
    }
  });

  it("confines its unsafe escape hatches to the directives that need them", () => {
    // 'unsafe-eval' exists only for the v1 plugin API's runtime Function()
    // compile; 'unsafe-inline' only for injected theme/snippet <style>.
    for (const [name, sources] of directives) {
      if (name !== "script-src") expect(sources, name).not.toContain("'unsafe-eval'");
      if (name !== "style-src") expect(sources, name).not.toContain("'unsafe-inline'");
    }
  });
});

it("ships the same policy in both app shells", () => {
  const [desktop, mobile] = SHELLS.map(readCsp);
  expect(mobile).toBe(desktop);
});

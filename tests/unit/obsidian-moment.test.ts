import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Obsidian re-exports `moment` from the 'obsidian' module and also exposes
 * it on `window.moment`, since plugins commonly reference either at module
 * scope (before onload() runs) — see GitHub issue #21. The window-attach is
 * a module-eval-time side effect, so each test needs a *fresh* module
 * instance: `vi.resetModules()` clears vitest's module registry, and a
 * dynamic `import()` re-evaluates the module rather than reusing a cached
 * instance from an earlier test.
 */
describe("obsidian shim: moment", () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const originalWindow = (globalThis as any).window;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (hadWindow) (globalThis as any).window = originalWindow;
    else delete (globalThis as any).window;
  });

  it("exports a real, working moment function", async () => {
    const GeodeAPI = await import("../../src/renderer/api/obsidian");
    expect(GeodeAPI.moment("2024-03-14").format("YYYY-MM-DD")).toBe("2024-03-14");
  });

  it("attaches moment to window at module-eval time", async () => {
    (globalThis as any).window = {};
    const GeodeAPI = await import("../../src/renderer/api/obsidian");
    expect((globalThis as any).window.moment).toBe(GeodeAPI.moment);
  });

  it("does not clobber a pre-existing window.moment", async () => {
    const hostMoment = () => "host-provided moment";
    (globalThis as any).window = { moment: hostMoment };
    await import("../../src/renderer/api/obsidian");
    expect((globalThis as any).window.moment).toBe(hostMoment);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyWindowChromeState } from "../../src/renderer/window-chrome";

describe("window chrome layout state", () => {
  it("marks a normal macOS window for traffic-light clearance", () => {
    const toggle = vi.fn();
    applyWindowChromeState({ toggle }, { platform: "darwin", isFullScreen: false });
    expect(toggle).toHaveBeenCalledWith("is-macos", true);
    expect(toggle).toHaveBeenCalledWith("is-native-fullscreen", false);
  });

  it("reacts to fullscreen and leaves non-mac platforms unscoped", () => {
    const toggle = vi.fn();
    applyWindowChromeState({ toggle }, { platform: "linux", isFullScreen: true });
    expect(toggle).toHaveBeenCalledWith("is-macos", false);
    expect(toggle).toHaveBeenCalledWith("is-native-fullscreen", true);
  });

  it("scopes the reduced inset and structural ribbon clearance to windowed macOS", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../styles/app.css"), "utf8");
    expect(css).toContain(
      "body.is-macos:not(.is-native-fullscreen) .mod-left .workspace-tab-header-container",
    );
    expect(css).toContain("padding-left: 38px");
    expect(css).toContain(
      "body.is-macos:not(.is-native-fullscreen) .workspace-ribbon.mod-left",
    );
    expect(css).toContain("margin-top: var(--header-height)");
    expect(css).not.toContain("padding-left: 78px");
  });
});

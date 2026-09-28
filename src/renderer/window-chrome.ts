export interface WindowChromeState {
  platform: string;
  isFullScreen: boolean;
  /**
   * "native": real macOS traffic lights (`titleBarStyle: "hiddenInset"`).
   * "drawn": frameless non-macOS window with a renderer-drawn fake titlebar
   * (opt-in screenshot mode, see main.ts's macChromeMode). "none": today's
   * plain native OS titlebar on non-macOS.
   */
  macChrome: "native" | "drawn" | "none";
}

/** Keep native-window layout state on body where shell and theme CSS can share it. */
export function applyWindowChromeState(
  body: Pick<DOMTokenList, "toggle">,
  state: WindowChromeState,
): void {
  // Keyed off the *effective* chrome mode, not literal platform, so drawn
  // (screenshot-mode) chrome on non-macOS reuses the same traffic-light
  // clearance CSS as real macOS without duplicating it.
  body.toggle("is-macos", state.macChrome !== "none");
  body.toggle("is-mac-chrome-drawn", state.macChrome === "drawn");
  body.toggle("is-native-fullscreen", state.isFullScreen);
}

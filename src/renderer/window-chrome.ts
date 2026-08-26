export interface WindowChromeState {
  platform: NodeJS.Platform;
  isFullScreen: boolean;
}

/** Keep native-window layout state on body where shell and theme CSS can share it. */
export function applyWindowChromeState(
  body: Pick<DOMTokenList, "toggle">,
  state: WindowChromeState,
): void {
  body.toggle("is-macos", state.platform === "darwin");
  body.toggle("is-native-fullscreen", state.isFullScreen);
}

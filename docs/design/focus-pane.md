# Focus pane

Temporarily make one center tab group take over the whole window so large
content (a design file, a wide table) is reviewable with the usual sidebars and
split layout still in place. Toggling again restores the exact prior layout.

## Using it

- Command: **Toggle focus on active pane** (`workspace:toggle-focus-pane`),
  default hotkey `Mod+Shift+Enter`.
- Tab header context menu: **Focus this pane** / **Exit focus**.
- While focused, the pane's tab bar shows an **Exit focus** button.

## Behavior

Focus is purely presentational. `Workspace.enterFocusPane()` adds CSS classes
(`is-focus-pane` on the workspace root, `is-focused-pane` on the target group,
`has-focused-pane` on its split ancestors); `styles/app.css` hides the sidebars,
split resize handles and every other center group. The split tree, split sizes,
sidebar widths and `collapsed` state are never touched, so exit is exact and
`serialize()` always yields the normal layout. Focus is not persisted across
relaunch.

Focus ends automatically when:

- the focused group is closed or emptied;
- another group is activated (opening a file or leaf into a hidden group, `revealLeaf`);
- a sidebar-docked leaf is revealed or a sidebar is shown/collapsed/expanded
  (the sidebar toggle commands and buttons only end focus and leave sidebar
  state as it was);
- a new split is created.

Focus is unavailable for sidebar groups and in the compact mobile layout. Esc
does not exit focus (it would collide with modals, vim mode and editor popups).

## API

`Workspace.focusedGroup`, `enterFocusPane(group?)`, `exitFocusPane()`,
`toggleFocusPane(group?)`, `isFocusedPane(group)`, and the `focus-pane-change`
event (argument: the focused group, or `null` on exit). Obsidian-compat shims
are unchanged.

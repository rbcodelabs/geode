# Private native-layer prototype captures

Synthetic vault only, actual Electron 42.10.0 on macOS, captured 2026-10-15.
Source and test commit `b309e13`; desktop viewport 1280×840 CSS pixels,
2560×1680 PNG at device scale 2. These show a private test-bundle experiment;
production App/Markdown/LP/Canvas/Base wiring remains unchanged.

- [Retained draft](retained-draft.png): after actual CM scroll, before saving.
  Original nested Base input remains focused with `9`; source file still has
  priority `2`. Same native root/direct layer parent since first mount.
- [After trusted pointer Return](after-pointer-return.png): after a real pointer
  click returns to the valid anchor. Original input stays focused with `9`, source
  remains priority `2`, and no Return-induced blur was recorded.

Both images were visually inspected. The fixed experimental frame clips the
file-name column and includes overlapping native Canvas toolbars; these captures
do not establish final layout, accessibility, mobile or arbitrary-height support.
The nine-case run has eight passes and one open keyboard recovery focus failure.
The original production viewport regression remains open. No complete native
boundary, named Workspaces runtime or Obsidian parity claim follows.

- [Dark narrow Return](dark-narrow-return.png): source `f08a1de`, actual Electron
  desktop window 760×740 CSS pixels, PNG 1520×1480 at scale 2. Both sidebars remain
  open. The responsive header keeps Return's actual center pointer reachable
  inside the existing frame; full label text remains in its accessible text/title.
  Captured native input `9` stays connected/focused with zero blur and source still
  priority `2`, but the priority column is clipped. This is Return reachability
  evidence, not a complete narrow native editing layout. Visually inspected.

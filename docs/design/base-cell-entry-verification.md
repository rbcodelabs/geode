# Nested Base cell pointer entry

A Base table selection moved focus from the surrounding editor into the table
container using browser-default focus scrolling. In nested Canvas presentations,
the first mousedown shifted the target cell upward by 135 pixels before mouseup.
Mouseup and the second click therefore landed on the container, and its double
click could not enter the intended cell.

The correction preserves focus transfer with `preventScroll` when selecting a
cell. Other edit, keyboard, blur, source-writing and ownership behavior is unchanged.

## Bounded evidence

On the unchanged shared-frontmatter baseline, real Reading and Live Preview
pointer double-clicks both failed. Trusted event snapshots showed the first
mousedown targeting a TD, synchronous focus into the table moving its rectangle
by exactly -135 pixels, and the remaining events targeting the container.

On candidate 190ef7e, those same two real double-click tests and the original
Canvas post-history rollback double-click test passed without retries (3/3).
The entry witnesses assert trusted TD mousedown/mouseup/double-click targets and
less than one pixel of cell-rectangle movement. Source bytes remain unchanged
until the explicit Enter save. The complete ancestor trace identifies the Canvas
surface as the scrolling ancestor; the unchanged post-save focus path can still
scroll it, which is outside this pointer-entry correction.

Five targeted unit cases cover selection without ancestor scrolling or writes,
read-only refusal, keyboard navigation without reacquiring focus, and touch tap
versus drag arbitration. With adjacent table/retry/ownership tests, 29 tests pass.
Typecheck and desktop/mobile build pass on the local host (no configured offload).

Broader Canvas and full regression gates remain pending. The existing lifetime
witnesses remain present with their original assertions; targeted entry success
does not establish complete nested-view lifecycle or Obsidian parity.

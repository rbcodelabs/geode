# Spike S2: overlay badge accuracy over the artifact webview

THROWAWAY harness. Not part of any release, never merged, no PR. Branch `spike/picker-s2-overlay-harness`
(based on `feat/picker-pins-g2-guest-anchors` at 4d677a85, which has the guest anchor tracker).

It answers the riskiest assumption in the Threads Design pins contract (design note section 7, spike S2): how far
off is an embedder-DOM badge from the element it marks inside the artifact `<webview>`, at DPR 2, with ProMotion, app
zoom, viewport presets, pane resize, inner scrollers, and CSS transforms on ancestors?

## What Rick does

Nothing but run it and leave the machine alone. It opens a visible Geode window (about 1300 x 800 css px, top left of
the main display), drives it by itself, and closes it. Do not touch the mouse or keyboard, do not put another window
over it, do not let the display sleep. Expected duration: 3 to 6 minutes on a Retina Mac (well under 10).

## Prerequisites

- macOS, on the real Retina display you actually use (the number we need is the Retina one). If an external non-Retina
  monitor is the main display, make the built-in display the main one first (the window opens on the main display).
- Node 22.6 or newer (the repo's `.mts` scripts rely on native type stripping). `node -v` to check.
- No network needed.

## Exact commands

```sh
cd <the geode checkout on branch spike/picker-s2-overlay-harness>
npm ci                 # first time only
npm run build          # produces dist/ (a few seconds)
npm run spike:s2 -- --out "$HOME/Documents/Personal/Products/Threads Design/Runs" --label rick-mbp
```

`--out <dir>` is where the two result files land (created if needed). Without it they go to
`spikes/picker-s2/results/` (git-ignored). `--label` is a name embedded in the file names.

Files written: `s2-<label>-<timestamp>.json` (everything, machine readable) and
`s2-<label>-<timestamp>.summary.txt` (the same summary that is printed at the end). Writing them straight into
`Products/Threads Design/Runs/` with `--out` as above is all that is needed to send them back.

Other flags: `--quick` (3 conditions per fixture, about 1 minute, a smoke test), `--fixtures plain,svgchart`
(subset; `--list` shows ids), `--no-replica` (skip the real pick-flow cross-check), `--strict` (exit 1 on an overall
FAIL; by default a FAIL verdict is a measurement, not a harness error). `S2_DUMP=<dir>` saves every captured
screenshot as a PNG for debugging.

Exit codes: 0 the harness ran (verdicts are in the output), 1 only with `--strict` on FAIL, 2 harness error (a
fixture or condition could not be measured, or the screenshot is not at physical resolution; details in the output
and JSON). The harness closes the Electron process it started, removes its temp directory, and does the same on
Ctrl-C. It kills only the pid it spawned (no `pkill`).

## What it measures

Fixtures (static pages, `spikes/picker-s2/lib/fixtures.mts`): `plain` (fractional and percentage boxes), `scroller`
(inner scroll container plus page scroll), `transform` (scale, translate, nested transforms on ancestors), `sticky`
(fixed and sticky elements), `zoomcss` (CSS `zoom`, nested), `extremes` (1x1 up to 5000x3000 px elements,
hairlines), `svgchart` (SVG marks, viewBox scaling, letterboxing).

Conditions (`plain` gets all of them, the others a core subset plus their scroll scenes): window size
small/medium/large, left sidebar open, both sidebars open, a drag-like live resize, artifact viewport presets
desktop/tablet/mobile, tablet with the stage scrolled, app zoom 80/125/150 percent (Electron
`webContents.setZoomFactor`, the mechanism behind the View menu zoom) alone and in tablet/mobile presets, page and
inner scrolling (also at zoom 125). DPR is whatever the display reports.

For each case:

1. The REAL guest tracker (the G2 anchor tracker in the artifact preload, through the view's bridge) reports the rect
   of every target, in guest css px.
2. A marker is placed in the embedder DOM (inside `.artifact-view-overlay`) with three mappings:
   - `existing`: a verbatim copy of what the production selection box does today
     (`ArtifactView.positionPopover`: `round(frame.left - stage.left + box.x)`, width/height rounded, min 2).
   - `border`: unrounded, origin includes the webview's own border (`frame.clientLeft/Top`).
   - `scaled`: `border` plus the guest-to-embedder scale (`frame.clientWidth / guest.innerWidth`).
3. The window is screenshotted (`webContents.capturePage`). Targets are painted in distinct saturated colours and
   found in the pixels with sub-pixel (coverage based) edges; each marker set is captured separately (targets hidden)
   and found the same way. Error = marker box minus true on-screen target box, in physical pixels (dx, dy, dw, dh)
   and in embedder css px. Edges clipped by the viewport or the pane are excluded.
4. A cross-check drives the real pick flow on `plain` and confirms the production selection box equals the copied
   formula (the `replica` line of the summary).

Verdict per condition: PASS when every case is within 1 css px, WARN when p95 is within 1 css px but some case is
beyond, FAIL when p95 is beyond. "css px" is embedder css px at the current app zoom. The table also prints `q`, the
size of one physical pixel in css px: the screenshot cannot resolve less, so on a DPR 1 machine at zoom 80 percent
(q = 1.25) a PASS is unreachable by construction. On the Retina Mac q is 0.5 (0.4 at 125 percent), so the verdicts
there are meaningful.

Also recorded: display scaleFactor, size, refresh rate as the OS reports it, Electron/Chrome/Node versions, OS, GPU
feature status, the measured `requestAnimationFrame` rate of the window at start and end (a ProMotion display shows
about 120 when the window is visible and in front), and a small report-lag benchmark (guest `scrollTo` until the
tracker's rect equals the true one).

## Known limitations

- Static screenshots: it cannot see frame-by-frame tearing or how a badge trails a fast scroll on ProMotion. It
  reports the steady-state error after settling, the rAF rate, and the tracker report lag (which includes the
  automation round trip, a few ms). Judging trailing during a real scroll needs eyes on a real scroll.
- Pixel snapping: Chromium snaps box edges to physical pixels, so a fractional box differs by up to 1 physical pixel
  in the screenshot whatever the mapping. That is a floor on measurable error, see `q`.
- Colour detection assumes a white fixture background and colours that do not appear in the app chrome; detection is
  limited to the stage region for that reason.
- Only the main display's scale factor is exercised; moving the window between a Retina and a non-Retina display is
  not tested.
- Capture resolution on Retina is handled defensively (the image's own highest scale factor, size checked against
  the byte length) but was only exercised at DPR 1 here. If the screenshot comes back below physical resolution the
  harness says so as a harness error (exit 2) and includes the image info in the JSON.
- Linux/xvfb runs (DPR 1) prove the mechanics only; their numbers are labelled "MECHANICS CHECK ONLY".

# Base row recovery captures

Captured 2026-10-15 from local macOS Electron using synthetic fixtures. Tested
source/tests: 190ef7e; docs-only HEAD during the run: 8295f6a. Full Canvas-owned
presentation suite: 21/21 passed, retries disabled. These are functional recovery
evidence, not a new visual design or complete mobile layout claim.

- [Desktop](base-row-recovery-desktop.png): actual Canvas Base row editor retains
  the revised value 10 after a rejected save; Retry Base save is available. The
  embedded viewport clips part of the left table content in this fixture.
- [Mobile controls](base-row-recovery-mobile-controls.png): 390×844 CSS viewport
  with the desktop app's mobile styling enabled; actual latest-value retry through
  Save cell edit. This is not native iOS verification. The horizontal Canvas
  presentation clips some surrounding controls; the tested Save control remains
  reachable and its click persists exactly one latest-value write.

Both captures were opened and visually inspected. Local committed files still
need the coordinator's authorized shared-report publication/display check; no
shared screenshot handoff completion is claimed here.

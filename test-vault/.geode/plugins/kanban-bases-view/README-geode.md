# kanban-bases-view (vendored test fixture)

This is the **unmodified shipped build** of the community plugin
[`kanban-bases-view`](https://github.com/welchcanavan/obsidian-bases-kanban)
v0.10.4 by I. Welch Canavan, MIT licensed (see `LICENSE`).

It is checked in as a test fixture for `tests/e2e/bases-plugin-view.spec.ts`,
which uses it as the real-world check that Geode's Bases plugin API can host a
third-party view. Using the published artifact rather than a hand-written
stand-in is the whole point: a stub would only prove Geode is consistent with
itself.

Installed but **disabled by default**, like `status-probe` — the e2e spec
enables it in its own throwaway vault copy. To refresh it, run `npm run build`
in the plugin's repo and copy `dist/{main.js,manifest.json,styles.css}` here.

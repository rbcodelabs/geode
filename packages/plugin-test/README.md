# @rbcodelabs/geode-plugin-test (spike)

Runs an Obsidian-style plugin against Geode's real `obsidian` implementation (`src/renderer/api`) in plain Chromium, with an in-memory vault. Replaces hand-written `obsidian` mocks for screenshot/UI tests.

```ts
const h = await launchPlugin({ plugins: [{ id: "my-plugin", dir: "./dist" }] });
await h.openView("my-plugin:view");
```

Build the harness bundle first: `npm run build -w packages/plugin-test`; set `CHROME=/path/to/chrome` if Playwright's browser isn't installed.

## Known limits
- The browser host is a mobile runtime (`is-mobile` on `<body>`), so plugins take their mobile code path. Desktop-only code (`fs`, Electron) does not run.
- Must be served from `http://localhost` (the fixture does this) — `crypto.randomUUID` is absent on fake origins.
- Bundle is ~6 MB: the shim pulls in the whole app. A lean core is future work.

## Layers
- `launchPlugin` (browser): `npm run test:plugin-harness`.
- `launchApp` (real Electron, desktop layout): exercised by `tests/e2e/plugin-harness.spec.ts` in the normal e2e run.

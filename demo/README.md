# Geode demo video

`demo/engine/` is the product demo engine from the Agentic PM Playbook
(`skills/product-demo-video`), vendored here. `demo/demo.config.json` is Geode's
script: the narration, the on-screen actions (each cued to the voice), and the
environment. Do not edit the engine in place; refresh it with the playbook's
`scripts/vendor-engine.ts`, which leaves this config alone.

```sh
npm install --prefix demo/engine           # once (run `node demo/engine/node_modules/electron/install.js` if Electron did not download)
export ELEVENLABS_VOICE_ID=<voice id>      # ELEVENLABS_API_KEY comes from the Geode keychain/env
npm run demo:doctor
npm run demo:all                           # voiceover -> record on the ssh host -> compose -> sync report
```

Output: `demo/out/getting-started-with-geode.mp4` and cue strips in `demo/out/sync/`.

Geode specifics (everything else is in the playbook skill):

- **Target:** the built Electron app (`npm run build` first; the remote setup does it) opening a
  fresh copy of `test-vault/` with `GEODE_SCREENSHOT_MODE=1` so Geode draws its own traffic lights on Linux.
- **Recording runs on a Linux host over ssh** (`environment.record.host`, currently the `dev-builder`
  alias). Compose runs here, on a Mac, for the real system font and dock icons.
- **If the compose step cannot find Electron** set `ELECTRON_PATH` to this repo's
  `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
- **If ssh says "Permission denied (publickey)"**, unlock the 1Password SSH agent and retry.
- Edit the narration or cues in `demo.config.json`; only changed scenes re-spend ElevenLabs credit.

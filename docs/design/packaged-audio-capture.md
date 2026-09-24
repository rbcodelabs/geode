# Packaged desktop audio capture

Geode desktop provides an optional `window.geode.audioCaptureWorklet` capability:

```ts
{ moduleUrl: string; processorName: "geode-pcm-capture-v1" }
```

The URL points to a fixed module included in the app's `dist` resources, including
packaged builds. Load it with `audioContext.audioWorklet.addModule(moduleUrl)` once
per context, then construct `AudioWorkletNode` with the advertised processor name.
The module posts `Float32Array` messages containing the first input channel at the
context's sample rate. It does not resample, recognize speech, or obtain microphone
permission. Callers own those operations and the stream/context lifetime.

Connect a media stream source to the node and the node to the context destination
to keep the graph active. The processor emits silence on all output channels;
microphone audio is never played back. On teardown, detach the message handler,
close the node port, disconnect both nodes, and release the caller's stream/context.

The asset loads under the existing `script-src 'self'` policy. No blob-script
allowance or new protocol handler is required. Mobile/browser hosts omit this
capability. Consumers must check for it and preserve their older-host fallback.

## Scope and decision

The approved change replaces Orchestrator's UI-thread capture fallback on capable
Geode hosts. A packaged AudioWorklet is the smallest change that removes the CSP
conflict while keeping audio processing off the UI thread. Allowing arbitrary blob
scripts would broaden policy; native capture and inference in a separate process
would require a larger platform integration. Neither is part of this change.

Inference, wake-word models, thresholds, and calibration remain unchanged. PCM
delivery and inference still involve the renderer; this is not a promise of
renderer-independent recognition or improved speech accuracy.

## Verification

`tests/e2e/audio-worklet.spec.ts` runs the built desktop app with synthetic audio.
It verifies module loading, nonzero PCM delivery, silent output, and rejection of
blob worklet scripts under the unchanged CSP. No physical microphone is used.

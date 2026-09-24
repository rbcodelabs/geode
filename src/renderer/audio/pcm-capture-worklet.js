// Packaged separately so AudioWorklet can load it under script-src 'self'.
// Keep inference out of the audio rendering thread: only copy mono PCM.
class GeodePcmCapture extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) this.port.postMessage(channel);
    // Consumers connect to the destination to keep the graph pulled. Never
    // play the captured microphone back through the speakers.
    for (const output of outputs) {
      for (const samples of output) samples.fill(0);
    }
    return true;
  }
}

registerProcessor("geode-pcm-capture-v1", GeodePcmCapture);

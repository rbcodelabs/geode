import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("packaged PCM worklet captures synthetic audio under the unchanged CSP", async () => {
  const root = path.resolve(__dirname, "../..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-audio-e2e-"));
  const app = await electron.launch({
    args: [root, `--user-data-dir=${temp}`, "--autoplay-policy=no-user-gesture-required"], cwd: root,
  });
  try {
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      const capability = (window as any).geode.audioCaptureWorklet;
      if (!capability) throw new Error("Missing packaged audio capture capability");
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
      const ctx = new AudioContext({ sampleRate: 16000 });
      const oscillator = ctx.createOscillator();
      try {
        await ctx.audioWorklet.addModule(capability.moduleUrl);
        const node = new AudioWorkletNode(ctx, capability.processorName);
        const analyser = ctx.createAnalyser();
        node.connect(analyser);
        analyser.connect(ctx.destination);
        const captured = new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("No nonzero PCM received")), 5000);
          node.port.onmessage = (event: MessageEvent<Float32Array>) => {
            const peak = Math.max(...event.data.map(Math.abs));
            if (peak > 0.1) { clearTimeout(timeout); resolve(peak); }
          };
        });
        oscillator.connect(node);
        oscillator.start();
        await ctx.resume();
        const peak = await captured;
        const output = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(output);
        node.port.onmessage = null;
        node.port.close();
        node.disconnect();
        const blob = URL.createObjectURL(new Blob(["registerProcessor('blocked', class extends AudioWorkletProcessor { process() { return true; } });"], { type: "application/javascript" }));
        let blobBlocked = false;
        try { await ctx.audioWorklet.addModule(blob); } catch { blobBlocked = true; }
        finally { URL.revokeObjectURL(blob); }
        return { peak, silent: output.every(value => value === 0), blobBlocked, csp, moduleUrl: capability.moduleUrl };
      } finally {
        oscillator.disconnect();
        await ctx.close();
      }
    });
    expect(result.moduleUrl).toMatch(/^file:.*\/pcm-capture-worklet\.js$/);
    expect(result.peak).toBeGreaterThan(0.1);
    expect(result.silent).toBe(true);
    expect(result.blobBlocked).toBe(true);
    expect(result.csp).not.toMatch(/script-src[^;]*blob:/);
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

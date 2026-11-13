// Mechanics self-test for lib/detect.mts: synthetic bitmaps with known boxes. `node spikes/picker-s2/selftest.mts`
import { detectBoxes } from "./lib/detect.mts";

const W = 200, H = 120;
function bitmap(): Uint8Array { const d = new Uint8Array(W * H * 4); d.fill(255); return d; }
function fill(d: Uint8Array, l: number, t: number, r: number, b: number, c: number[], cover = 1): void {
  for (let y = Math.floor(t); y < Math.ceil(b); y++) for (let x = Math.floor(l); x < Math.ceil(r); x++) {
    const cx = Math.min(x + 1, r) - Math.max(x, l), cy = Math.min(y + 1, b) - Math.max(y, t);
    const a = Math.max(0, cx) * Math.max(0, cy) * cover;
    const i = (y * W + x) * 4;
    d[i] = 255 - a * (255 - c[2]!); d[i + 1] = 255 - a * (255 - c[1]!); d[i + 2] = 255 - a * (255 - c[0]!);
  }
}
const magenta = [255, 0, 255], blue = [0, 0, 255];
const d = bitmap();
fill(d, 10, 20, 50, 60, magenta);          // integer box
fill(d, 100.4, 30.25, 150.9, 70.5, blue);  // fractional box
const [a, b] = detectBoxes(d, W, H, [magenta, blue]) as any[];
const close = (x: number, y: number, tol = 0.06) => Math.abs(x - y) <= tol;
let bad = 0;
const check = (name: string, got: number, want: number) => { const ok = close(got, want); if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: got ${got.toFixed(2)} want ${want}`); };
check("int left", a.left, 10); check("int top", a.top, 20); check("int right", a.right, 50); check("int bottom", a.bottom, 60);
check("frac left", b.left, 100.4); check("frac top", b.top, 30.25); check("frac right", b.right, 150.9); check("frac bottom", b.bottom, 70.5);
const e = bitmap();
const [none] = detectBoxes(e, W, H, [magenta]) as any[];
if (none.found) { bad++; console.log("FAIL blank page found a box"); } else console.log("ok   blank page finds nothing");
process.exit(bad ? 1 : 0);

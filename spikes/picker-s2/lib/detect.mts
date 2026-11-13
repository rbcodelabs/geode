/**
 * Pixel analysis for spike S2. SELF-CONTAINED on purpose: `detectBoxes.toString()` is shipped into the Electron main
 * process (where the screenshot lives) so a 20 MB Retina bitmap never crosses the automation channel. Do not import
 * anything or reference outer variables inside it.
 *
 * Finds, for each palette colour, the sub-pixel bounding box of the pixels that are that colour on a white page.
 * A pixel belongs to colour C when it lies on the line white -> C (alpha = coverage), within a small residual, so
 * anti-aliased edges contribute their coverage instead of being thrown away.
 *
 *   data     BGRA bytes (Electron NativeImage.toBitmap(), little endian)
 *   palette  [[r, g, b], ...]  saturated colours that do not occur anywhere else in the page
 *   region   only pixels inside [x0, x1) x [y0, y1) count (the app chrome has accent colours of its own)
 */
export function detectBoxes(
  data: Uint8Array,
  width: number,
  height: number,
  palette: number[][],
  region?: { x0: number; y0: number; x1: number; y1: number },
): Array<{ found: boolean; count: number; left: number; top: number; right: number; bottom: number }> {
  const n = palette.length;
  const RESIDUAL = 30;
  const dv = palette.map((c) => [255 - c[0]!, 255 - c[1]!, 255 - c[2]!]);
  const dd = dv.map((v) => v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
  const minX = new Array<number>(n).fill(Infinity), maxX = new Array<number>(n).fill(-1);
  const minY = new Array<number>(n).fill(Infinity), maxY = new Array<number>(n).fill(-1);
  const count = new Array<number>(n).fill(0);

  // alpha of pixel offset `i` for colour `c`: coverage along white -> colour, 0 when the pixel is off that line.
  const alphaAt = (i: number, c: number): number => {
    const qr = 255 - data[i + 2]!, qg = 255 - data[i + 1]!, qb = 255 - data[i]!;
    const a = (qr * dv[c]![0]! + qg * dv[c]![1]! + qb * dv[c]![2]!) / dd[c]!;
    if (a < 0.02 || a > 1.2) return 0;
    const rr = qr - a * dv[c]![0]!, rg = qg - a * dv[c]![1]!, rb = qb - a * dv[c]![2]!;
    if (Math.sqrt(rr * rr + rg * rg + rb * rb) > RESIDUAL) return 0;
    return a > 1 ? 1 : a;
  };

  const rx0 = region ? Math.max(0, Math.floor(region.x0)) : 0, rx1 = region ? Math.min(width, Math.ceil(region.x1)) : width;
  const ry0 = region ? Math.max(0, Math.floor(region.y0)) : 0, ry1 = region ? Math.min(height, Math.ceil(region.y1)) : height;
  for (let y = ry0; y < ry1; y++) {
    const row = y * width * 4;
    for (let x = rx0; x < rx1; x++) {
      const i = row + x * 4;
      if (data[i]! > 245 && data[i + 1]! > 245 && data[i + 2]! > 245) continue;
      for (let c = 0; c < n; c++) {
        if (alphaAt(i, c) >= 0.5) {
          count[c]!++;
          if (x < minX[c]!) minX[c] = x;
          if (x > maxX[c]!) maxX[c] = x;
          if (y < minY[c]!) minY[c] = y;
          if (y > maxY[c]!) maxY[c] = y;
          break;
        }
      }
    }
  }

  // Sub-pixel edges from the coverage along the middle row / column of the coarse box.
  const edges = (c: number, vertical: boolean): [number, number] => {
    const lo = vertical ? minY[c]! : minX[c]!, hi = vertical ? maxY[c]! : maxX[c]!;
    const fixed = vertical ? Math.floor((minX[c]! + maxX[c]!) / 2) : Math.floor((minY[c]! + maxY[c]!) / 2);
    const from = Math.max(vertical ? ry0 : rx0, lo - 4), to = Math.min(vertical ? ry1 - 1 : rx1 - 1, hi + 4);
    const alpha: number[] = [];
    for (let k = from; k <= to; k++) {
      const i = vertical ? (k * width + fixed) * 4 : (fixed * width + k) * 4;
      alpha.push(alphaAt(i, c));
    }
    let first = -1, last = -1;
    for (let k = 0; k < alpha.length; k++) if (alpha[k]! >= 0.97) { if (first < 0) first = k; last = k; }
    if (first < 0) return [lo, hi + 1]; // thinner than a pixel: the coarse box is all there is
    let before = 0, after = 0;
    for (let k = Math.max(0, first - 3); k < first; k++) before += alpha[k]!;
    for (let k = last + 1; k <= Math.min(alpha.length - 1, last + 3); k++) after += alpha[k]!;
    return [from + first - before, from + last + 1 + after];
  };

  const out = [];
  for (let c = 0; c < n; c++) {
    if (count[c]! === 0) { out.push({ found: false, count: 0, left: 0, top: 0, right: 0, bottom: 0 }); continue; }
    const [left, right] = edges(c, false);
    const [top, bottom] = edges(c, true);
    out.push({ found: true, count: count[c]!, left, top, right, bottom });
  }
  return out;
}

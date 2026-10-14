import qrcode from "qrcode-generator";
import jsQR from "jsqr";

/** Error-correction M: the code is shown on a screen and read by a phone camera, so a little damage tolerance beats a smaller symbol. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M"); qr.addData(text, "Byte"); qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** An accessible SVG (dark modules on a white quiet zone) that scales to its container. */
export function renderQrSvg(text: string, label: string, quiet = 4): SVGSVGElement {
  const matrix = qrMatrix(text), size = matrix.length + quiet * 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG_NS, "rect"); bg.setAttribute("width", String(size)); bg.setAttribute("height", String(size)); bg.setAttribute("fill", "#fff"); svg.append(bg);
  let d = "";
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
  const path = document.createElementNS(SVG_NS, "path"); path.setAttribute("d", d); path.setAttribute("fill", "#000"); svg.append(path);
  return svg;
}

/** Rasterises a matrix to RGBA, the form `jsQR` (and a camera frame) uses. Used by tests to prove encode/decode agree. */
export function matrixToRgba(matrix: boolean[][], scale = 4, quiet = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const side = (matrix.length + quiet * 2) * scale, data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) {
    if (!matrix[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const at = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4; data[at] = data[at + 1] = data[at + 2] = 0; }
  }
  return { data, width: side, height: side };
}

/** Decodes pixels to text, or null. The result is untrusted: callers pass it to parseInvitation. */
export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}

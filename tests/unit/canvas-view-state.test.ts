import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CanvasView } from "../../src/renderer/views/canvas-view";

function viewWith(files: Record<string, { path: string; extension: string }>) {
  const setFile = vi.fn(async () => {});
  const view = Object.create(CanvasView.prototype) as CanvasView & Record<string, unknown>;
  view.app = { vault: { getFileByPath: (p: string) => files[p] ?? null } };
  view.setFile = setFile;
  return { view, setFile };
}

describe("CanvasView view state (Obsidian setViewState parity)", () => {
  it("getState reports the open .canvas path, or null when empty", () => {
    const { view } = viewWith({});
    expect(view.getState()).toEqual({ file: null });
    view.file = { path: "A/board.canvas" } as never;
    expect(view.getState()).toEqual({ file: "A/board.canvas" });
  });

  it("setState({file}) loads the canvas file", async () => {
    const f = { path: "A/board.canvas", extension: "canvas" };
    const { view, setFile } = viewWith({ [f.path]: f });
    await view.setState({ file: f.path });
    expect(setFile).toHaveBeenCalledWith(f);
  });

  it("setState is tolerant of missing, non-canvas, or malformed state", async () => {
    const { view, setFile } = viewWith({ "n.md": { path: "n.md", extension: "md" } });
    await view.setState({ file: "gone.canvas" });
    await view.setState({ file: "n.md" });
    await view.setState({ file: 5 });
    await view.setState(null);
    expect(setFile).not.toHaveBeenCalled();
  });
});

describe("source guards", () => {
  it("app registers a 'canvas' view factory", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/app.ts"), "utf8");
    expect(src).toMatch(/registerViewFactory\("canvas",\s*\(\)\s*=>\s*new CanvasView\(this\)\)/);
  });

  it("live artboard webview is display:flex so Electron's inner iframe fills the frame", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../styles/app.css"), "utf8");
    const rule = (css.match(/\.canvas-artboard-webview \{[^}]*\}/)?.[0] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).not.toMatch(/display:\s*block/);
  });
});

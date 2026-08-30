import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("mobile renderer build boundary", () => {
  it("builds through the enforced mobile target with no Electron, Node, or main-process inputs", () => {
    const root = path.resolve(__dirname, "../../..");
    const result = spawnSync(process.execPath, ["esbuild.config.mjs", "--mobile-only"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);

    const mobileRoot = path.join(root, "dist/mobile");
    expect(fs.readFileSync(path.join(mobileRoot, "index.html"), "utf8")).toContain('src="./mobile-renderer.js"');
    expect(fs.readFileSync(path.join(mobileRoot, "index.html"), "utf8")).toContain('href="./app.css"');
    expect(fs.statSync(path.join(mobileRoot, "app.css")).size).toBeGreaterThan(0);
    expect(fs.readdirSync(mobileRoot).filter((file) => file.endsWith(".wasm"))).toEqual([]);
    expect(fs.readFileSync(path.join(mobileRoot, "mobile-renderer.js"), "utf8")).toContain("WebAssembly.compile");

    const sourceMap = JSON.parse(fs.readFileSync(path.join(mobileRoot, "mobile-renderer.js.map"), "utf8")) as {
      sources: string[];
    };
    expect(sourceMap.sources.filter((source) =>
      source.includes("src/main/") ||
      source.includes("electron-host") ||
      source.includes("node:") ||
      /node_modules\/electron(?:\/|$)/.test(source)
    )).toEqual([]);
  });
});

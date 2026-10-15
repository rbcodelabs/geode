// Private experiment bundle only. Production esbuild entries remain unchanged.
import { build } from "esbuild";
await build({ entryPoints: ["tests/fixtures/native-layer-prototype.ts"], outfile: "dist/native-layer-prototype.js", bundle: true, platform: "browser", format: "iife", target: "es2022", sourcemap: true, logLevel: "info" });

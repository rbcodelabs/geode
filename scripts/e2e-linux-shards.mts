#!/usr/bin/env node
/**
 * Run the Playwright E2E suite on a headless Linux box (CI, a test worker).
 *
 *   node scripts/e2e-linux-shards.mts [--shards=2] [-- <extra playwright args>]
 *
 * Why not just `playwright test --workers=N`: on Linux a headless run maps each
 * Electron window on an Xvfb display (see headlessNeedsMappedWindow in
 * src/main/main.ts), and Xvfb has no window manager. Two workers on ONE display
 * share one input focus, so hover cards, focus-dependent menus and modals in
 * one worker break while another worker's window takes the focus. Each shard
 * here therefore gets its own `xvfb-run` display and runs a single worker.
 *
 * Exit code is non-zero if any shard failed. Run `npm run build` first.
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const dash = args.indexOf("--");
const own = dash >= 0 ? args.slice(0, dash) : args;
const extra = dash >= 0 ? args.slice(dash + 1) : [];
const shardsArg = own.find((a) => a.startsWith("--shards="));
const shards = Math.max(1, Number(shardsArg?.split("=")[1] ?? 2));

function runShard(index: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "xvfb-run",
      ["-a", "npx", "playwright", "test", "--workers=1", "--retries=0", `--shard=${index}/${shards}`, ...extra],
      { stdio: "inherit", env: { ...process.env, GEODE_E2E_SHARD: String(index) } },
    );
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const codes = await Promise.all(Array.from({ length: shards }, (_, i) => runShard(i + 1)));
const failed = codes.filter((code) => code !== 0).length;
console.log(`\ne2e shards: ${shards - failed}/${shards} passed (exit codes ${codes.join(", ")})`);
process.exit(failed ? 1 : 0);

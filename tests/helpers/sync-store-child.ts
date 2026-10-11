// Bundled by esbuild in tests (see sync-store-harness.ts) and run as a real child process.
//   serve  <store>                 -> serveStore over stdin/stdout, logs to stderr
//   append <store> <prefix> <n>    -> opens the store's vault and appends n records
import { FsStoreProvider, serveStore } from "../../src/sync-node/index";

const [mode, store, prefix, count] = process.argv.slice(2);
const never = new AbortController().signal;

async function main() {
  if (mode === "serve") {
    if (typeof (globalThis as any).gc === "function") setInterval(() => (globalThis as any).gc(), 20).unref(); // measure retention, not allocator laziness
    const stats = { peakBuffered: 0, framesIn: 0, maxFrameIn: 0, framesOut: 0 };
    await serveStore({ store, input: process.stdin, output: process.stdout, log: line => process.stderr.write(line + "\n"), stats });
    process.stderr.write(`STATS ${JSON.stringify({ ...stats, maxRssKb: process.resourceUsage().maxRSS })}\n`);
    return;
  }
  if (mode === "append") {
    const provider = new FsStoreProvider(store);
    const [binding] = await provider.discover(never);
    const session = await provider.open({ binding, deviceId: "child-" + prefix }, never);
    for (let i = 0; i < Number(count); i++) {
      const id = `${prefix}-${i}`;
      await session.appendRecord({ schema: 1, vaultId: binding.vaultId, recordId: id, operationId: id + "-op", deviceId: prefix, entityId: "e-" + id, namespace: "content", parents: [], kind: "file", deleted: false, location: { parentId: null, name: id + ".md" } }, never);
    }
    return;
  }
  throw new Error("unknown mode " + mode);
}
main().then(() => process.exit(0), error => { process.stderr.write(String(error?.stack ?? error) + "\n"); process.exit(1); });

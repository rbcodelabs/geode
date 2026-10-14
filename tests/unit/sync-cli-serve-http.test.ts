import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import { WS_SUBPROTOCOL, WS_TOKEN_PREFIX } from "../../src/shared/store-protocol";
import { rawUpgrade } from "../helpers/ws-raw";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "geode-serve-http-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cli(args: string[], stopSignal?: AbortSignal) {
  const err: string[] = [], out: string[] = [];
  const done = run(args, { streams: { out: t => { out.push(t); }, err: t => { err.push(t); } }, env: {}, stdin: Readable.from([]), ...(stopSignal ? { stopSignal } : {}) });
  return { done, err: () => err.join(""), out: () => out.join("") };
}

describe("geode-wiki sync serve --http", () => {
  const TOKEN = "cli-token-" + "x".repeat(30);
  it("is a usage error without a token file, with a short token, with a bad --listen, or with --listen but no --http", async () => {
    const store = dir(), file = join(dir(), "token");
    expect((await cli(["sync", "serve", "--store", store, "--http"]).done)).toBe(2);
    writeFileSync(file, "short\n", { mode: 0o600 });
    expect((await cli(["sync", "serve", "--store", store, "--http", "--token-file", file]).done)).toBe(2);
    writeFileSync(file, TOKEN + "\n");
    expect((await cli(["sync", "serve", "--store", store, "--http", "--token-file", file, "--listen", "nonsense"]).done)).toBe(2);
    expect((await cli(["sync", "serve", "--store", store, "--listen", "127.0.0.1:1"]).done)).toBe(2);
    expect((await cli(["sync", "serve", "--store", store, "--http", "--token-file", join(store, "absent")]).done)).toBe(2);
  });

  it("serves on the requested loopback port until stopped, requires the token", async () => {
    const store = dir(), file = join(dir(), "token"), stop = new AbortController();
    writeFileSync(file, TOKEN + "\n"); chmodSync(file, 0o600);
    const free = await rawFreePort();
    const served = cli(["sync", "serve", "--store", store, "--http", "--token-file", file, "--listen", `127.0.0.1:${free}`], stop.signal);
    for (let i = 0; i < 100 && !served.err().includes("serving"); i++) await new Promise(r => setTimeout(r, 20));
    expect(served.err()).toContain(`ws://127.0.0.1:${free}`);
    expect((await rawUpgrade(free, {})).status).toBe(401);
    const ok = await rawUpgrade(free, { "Sec-WebSocket-Protocol": `${WS_SUBPROTOCOL}, ${WS_TOKEN_PREFIX}${Buffer.from(TOKEN).toString("base64url")}` });
    expect(ok.status).toBe(101);
    ok.socket!.destroy();
    stop.abort();
    expect(await served.done).toBe(0);
    expect(served.err()).toContain("stopped");
    expect(served.out()).toBe("");
  });
});

async function rawFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise(resolve => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
}

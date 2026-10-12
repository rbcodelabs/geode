import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import { HubStoreManager } from "../../src/sync-node/app-hub";
import { appDevice, hubCounts, rmrf, tmpDir, tree } from "../helpers/app-hub-harness";
import { cleanBundle, childBundle } from "../helpers/sync-store-harness";
import { put } from "../helpers/node-host-harness";

/**
 * The default ssh path of HubStoreManager (spawnSshStore: the real `ssh` binary on PATH, BatchMode, ConnectTimeout)
 * against stand-in `ssh` executables placed first on PATH. One runs the real store server the way
 * `ssh host geode-wiki sync serve --store <path>` would; the others fail the ways real ssh fails (auth, DNS, a hang).
 */
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const dir = (prefix: string) => { const d = tmpDir(prefix); dirs.push(d); return d; };
const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; delete process.env.FAKE_SSH_LOG; for (const d of dirs.splice(0)) rmrf(d); });
afterAll(() => cleanBundle());

/** Installs `ssh` first on PATH. `body` is a /bin/sh script body; `"$last"` is the remote command. */
function installSsh(body: string): string {
  const bin = dir("ssh-bin");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nfor last; do :; done\n${body}\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  return bin;
}

describe("the default ssh transport", () => {
  it("syncs a vault end to end through ssh and converges with the CLI on the same store directory", async () => {
    const child = await childBundle(), store = dir("remote-store");
    const log = join(dir("log"), "ssh-args");
    // The stand-in "remote": records its argv, then runs the same server `geode-wiki sync serve --store <path>` is.
    installSsh(`printf '%s\\n' "$@" > "$FAKE_SSH_LOG"\nstorepath=$(printf '%s' "$last" | sed "s/.*--store '\\(.*\\)'$/\\1/")\nexec "${process.execPath}" "${child}" serve "$storepath"`);
    process.env.FAKE_SSH_LOG = log;

    const app = appDevice({ vault: dir("app-vault"), userData: dir("app-ud") });
    await app.configure({ kind: "ssh", host: "geode-hub", path: store }, true);
    put(app.vault, "FromApp.md", "app over ssh"); put(app.vault, "Dir/Deep.md", "deep");
    await app.connect({ create: "Personal" });
    await app.firstSync();

    // ssh was invoked non-interactively, with a connect timeout, to the configured alias, running the documented command.
    const argv = readFileSync(log, "utf8").trim().split("\n");
    expect(argv).toEqual(expect.arrayContaining(["-o", "BatchMode=yes", "ConnectTimeout=10", "geode-hub"]));
    expect(argv[argv.length - 1]).toBe(`geode-wiki sync serve --store '${store}'`);

    // A CLI device on the store directory itself (the hub machine's own view) converges with it.
    const cliRoot = dir("cli-root"), env = { GEODE_SYNC_HOME: dir("cli-home") };
    const cli = (sub: string, ...rest: string[]) => run(["sync", sub, "--root", cliRoot, "--settle-ms", "0", "--json", ...rest], { streams: { out: () => {}, err: () => {} }, env, stdin: Readable.from([]) });
    expect(await cli("init", "--store", store)).toBe(0);
    expect(await cli("preview")).toBe(0); expect(await cli("preview", "--approve")).toBe(0); expect(await cli("run")).toBe(0);
    expect(tree(cliRoot)).toEqual({ "FromApp.md": "app over ssh", "Dir/Deep.md": "deep" });

    put(cliRoot, "FromCli.md", "cli note");
    expect(await cli("run")).toBe(0);
    await app.sync();
    expect(tree(app.vault)).toEqual(tree(cliRoot));
    const settled = hubCounts(store);
    await app.sync(); expect(hubCounts(store)).toEqual(settled);
    await app.close();
  });

  it("reports a refused key as an authentication problem, quickly, without prompting", async () => {
    installSsh(`echo "rick@geode-hub: Permission denied (publickey)." >&2\nexit 255`);
    const manager = new HubStoreManager();
    const started = Date.now();
    await expect(manager.discover({ kind: "ssh", host: "geode-hub", path: "/h" })).rejects.toMatchObject({ code: "ssh-auth", hint: expect.stringContaining("agent") });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports an unresolvable host and a hub without geode-wiki", async () => {
    installSsh(`echo "ssh: Could not resolve hostname nowhere: Name or service not known" >&2\nexit 255`);
    await expect(new HubStoreManager().discover({ kind: "ssh", host: "nowhere", path: "/h" })).rejects.toMatchObject({ code: "ssh-unreachable" });
    installSsh(`echo "bash: geode-wiki: command not found" >&2\nexit 127`);
    await expect(new HubStoreManager().discover({ kind: "ssh", host: "geode-hub", path: "/h" })).rejects.toMatchObject({ code: "ssh-no-geode-wiki" });
  });

  it("a hung ssh is an error after the deadline, not a hang, and the child is gone", async () => {
    const pidFile = join(dir("pid"), "pid");
    installSsh(`echo $$ > "${pidFile}"\nexec sleep 30`);
    const manager = new HubStoreManager({ connectTimeoutMs: 400 });
    const started = Date.now();
    await expect(manager.discover({ kind: "ssh", host: "geode-hub", path: "/h" })).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("Timed out") });
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 3000 });
  });
});

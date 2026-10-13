import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHubUrl, hubTargetProblem, hubTokenKey, hubUrlProblem } from "../../src/shared/hub-sync";
import { HubSyncError, HubSyncProvider, describeHubTarget, normaliseTarget, type HubSecretStore } from "../../src/renderer/sync/hub-provider";
import { validateHubTarget } from "../../src/sync-node/app-hub";
import { startHttpStoreServer, type HttpStoreServer } from "../../src/sync-node/index";
import { appDevice, rmrf, tmpDir, tree } from "../helpers/app-hub-harness";
import { put } from "../helpers/node-host-harness";
import { HTTP_TEST_TOKEN } from "../helpers/sync-store-harness";

vi.setConfig({ testTimeout: 90_000 });

describe("the HTTPS hub target is validated like a hostile input", () => {
  const good = ["https://claude-box.tail1234.ts.net", "https://claude-box.tail1234.ts.net/", "wss://hub.example:8443/geode", "https://100.101.102.103", "https://[fd7a:115c:a1e0::1]:8443/x", "https://hub.example/a?b=c#frag"];
  const bad: Array<[string, string]> = [
    ["", "Enter the hub URL"], ["   ", "Enter the hub URL"], ["http://hub.example", "https:// or wss://"], ["ws://hub.example", "https:// or wss://"], ["ftp://hub.example", "https:// or wss://"],
    ["javascript:alert(1)", "https:// or wss://"], ["file:///etc/passwd", "https:// or wss://"], ["data:text/plain,hi", "https:// or wss://"], ["hub.example", "not a valid URL"], ["https://", "not a valid URL"],
    ["https://user:secret@hub.example", "user name or password"], ["https://user@hub.example", "user name or password"],
    ["https://hub.example/\npath", "printable ASCII"], ["https://hub.example/ path", "printable ASCII"], ["https://hub.example/\tpath", "printable ASCII"], ["https://hub.example/\u0000", "printable ASCII"],
    ["https://hub.exämple", "printable ASCII"], ["https://hub.example\\@evil.example", "backslash"], ["https://evil.example‮/moc.hub", "printable ASCII"], ["https://" + "a".repeat(2100), "too long"],
  ];
  it.each(good)("accepts %s", url => { expect(hubUrlProblem(url)).toBeNull(); expect(hubTargetProblem({ kind: "http", url })).toBeNull(); });
  it.each(bad)("refuses %j", (url, reason) => { expect(hubUrlProblem(url)).toContain(reason); expect(hubTargetProblem({ kind: "http", url })).toContain(reason); });
  it("refuses non-string and missing urls and keeps refusing unknown kinds", () => {
    for (const url of [undefined, null, 42, {}, ["https://a.example"]]) expect(hubTargetProblem({ kind: "http", url })).toContain("Enter the hub URL");
    expect(hubTargetProblem({ kind: "gopher", path: "/x" })).toBe("Unknown hub kind");
  });
  it("canonicalises a good URL and keys the token by host:port, case-insensitively, scheme-independently", () => {
    expect(canonicalHubUrl("  https://Hub.Example:443/x#frag ")).toBe("https://hub.example/x");
    expect(hubTokenKey("https://Hub.Example:8443/a")).toBe("hub-token/hub.example:8443");
    expect(hubTokenKey("wss://hub.example:8443/b")).toBe(hubTokenKey("https://HUB.example:8443/"));
    expect(hubTokenKey("https://hub.example")).not.toBe(hubTokenKey("https://other.example"));
  });
  it("normaliseTarget / describeHubTarget handle http, and an invalid URL stays visible to the validator", () => {
    expect(normaliseTarget({ kind: "http", url: " https://Hub.example#x " })).toEqual({ kind: "http", url: "https://hub.example/" });
    expect(describeHubTarget({ kind: "http", url: "https://hub.example/" })).toBe("https://hub.example/");
    expect(hubTargetProblem(normaliseTarget({ kind: "http", url: " ftp://nope " }))).toContain("https:// or wss://");
  });
  it("the main process refuses an http target (it never crosses IPC)", () => {
    expect(() => validateHubTarget({ kind: "http", url: "https://hub.example" })).toThrow(/not through the main process/);
  });
});

/** An in-memory secure store; `entries` lets a test assert exactly what was kept and where. */
function secretStore(available = true): HubSecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return { available, entries, get: async k => entries.get(k) ?? null, set: async (k, v) => { entries.set(k, v); }, remove: async k => { entries.delete(k); } };
}
function deviceState() {
  const state = new Map<string, unknown>();
  return { state, read: async <T>(k: string) => (state.has(k) ? structuredClone(state.get(k)) : null) as T | null, write: async (k: string, v: unknown) => { state.set(k, structuredClone(v)); }, remove: async (k: string) => { state.delete(k); } };
}

describe("HubSyncProvider with an HTTPS target: configuration and the token", () => {
  it("saves the URL in device state but the token only in secure storage, never in either place twice", async () => {
    const secrets = secretStore(), device = deviceState();
    const provider = new HubSyncProvider(undefined, device, () => "/vault", { secrets });
    expect(provider.supportedKinds).toEqual(["http"]);
    await provider.setConfig({ schema: 1, target: { kind: "http", url: " https://Hub.example " }, create: false });
    await provider.setToken("https://hub.example/", "  s3cret-token-value  ");
    expect(await provider.getConfig()).toEqual({ schema: 1, target: { kind: "http", url: "https://hub.example/" }, create: false });
    expect([...secrets.entries]).toEqual([["hub-token/hub.example", "s3cret-token-value"]]);
    expect(JSON.stringify([...device.state])).not.toContain("s3cret");
    expect(await provider.hasToken("https://hub.example/")).toBe(true);
    expect(await provider.hasToken("https://other.example/")).toBe(false);
    await provider.clearToken("https://hub.example/");
    expect(secrets.entries.size).toBe(0);
  });

  it("with no secure storage it refuses the token with a clear message and keeps it nowhere", async () => {
    const device = deviceState();
    for (const secrets of [secretStore(false), undefined]) {
      const provider = new HubSyncProvider(undefined, device, () => "/vault", secrets ? { secrets } : {});
      expect(provider.canStoreToken).toBe(false);
      await expect(provider.setToken("https://hub.example/", "tok")).rejects.toMatchObject({ code: "secure-storage-unavailable", message: expect.stringMatching(/Secure storage is unavailable/) });
      expect(await provider.hasToken("https://hub.example/")).toBe(false);
    }
    expect(device.state.size).toBe(0);
  });

  it("refuses hostile URLs and empty tokens when saving", async () => {
    const provider = new HubSyncProvider(undefined, deviceState(), () => "/vault", { secrets: secretStore() });
    await expect(provider.setConfig({ schema: 1, target: { kind: "http", url: "http://hub.example" }, create: false })).rejects.toMatchObject({ code: "invalid-target" });
    await expect(provider.setConfig({ schema: 1, target: { kind: "http", url: "https://u:p@hub.example" }, create: false })).rejects.toMatchObject({ code: "invalid-target" });
    await expect(provider.setToken("https://hub.example/", "   ")).rejects.toMatchObject({ code: "invalid-token" });
    await expect(provider.setToken("javascript:alert(1)", "tok")).rejects.toMatchObject({ code: "invalid-target" });
  });

  it("without a main-process bridge, folder and ssh targets fail by name instead of crashing", async () => {
    const device = deviceState();
    await device.write("sync-hub/config//vault", { schema: 1, target: { kind: "fs", path: "/srv/hub" }, create: false });
    const provider = new HubSyncProvider(undefined, device, () => "/vault", { secrets: secretStore() });
    await expect(provider.discover(new AbortController().signal)).rejects.toMatchObject({ code: "unsupported-target" });
  });
});

describe("two app devices with no main-process bridge converge through a real HTTPS-hub server", () => {
  const cleanups: string[] = [], servers: HttpStoreServer[] = [];
  const dir = (prefix: string) => { const d = tmpDir(prefix); cleanups.push(d); return d; };
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const d of cleanups.splice(0)) rmrf(d); });

  async function setup(clientToken = HTTP_TEST_TOKEN) {
    const store = dir("http-hub"), server = await startHttpStoreServer({ store, token: HTTP_TEST_TOKEN, port: 0, pingIntervalMs: 60_000 });
    servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/`;
    const make = (name: string) => {
      const secrets = secretStore();
      secrets.entries.set(hubTokenKey(url), clientToken);
      const d = appDevice({ vault: dir(`${name}-vault`), userData: dir(`${name}-userdata`), noBridge: true, ignorePortableConfig: true, providerOptions: { secrets, http: { allowInsecure: true } } });
      return Object.assign(d, { secrets, write: (rel: string, text: string) => put(d.vault, rel, text), read: (rel: string) => readFileSync(join(d.vault, rel), "utf8"), has: (rel: string) => existsSync(join(d.vault, rel)), remove: (rel: string) => rmSync(join(d.vault, rel), { force: true }) });
    };
    return { store, server, url, make };
  }

  it("creates, edits and deletes propagate both ways; the token never reaches device state or the vault", async () => {
    const { url, make, store } = await setup();
    const a = make("a"), b = make("b");
    a.write("Home.md", "home"); a.write("Projects/Plan.md", "plan v1"); a.write("Doomed.md", "doomed");
    await a.configureUnchecked({ kind: "http", url }, true); await b.configureUnchecked({ kind: "http", url });
    await a.connect({ create: "Wiki" });
    const first = await a.firstSync();
    expect(first.result).toBeTruthy();
    await b.connect("join");
    await b.firstSync();
    expect(tree(b.vault)).toEqual(tree(a.vault));
    expect(b.read("Projects/Plan.md")).toBe("plan v1");

    a.write("Projects/Plan.md", "plan v2 from A"); b.write("FromB.md", "hello from b"); a.remove("Doomed.md");
    await a.sync(); await b.sync(); await a.sync();
    expect(tree(a.vault)).toEqual(tree(b.vault));
    expect(a.read("FromB.md")).toBe("hello from b");
    expect(b.read("Projects/Plan.md")).toBe("plan v2 from A");
    expect(b.has("Doomed.md")).toBe(false);

    // The token lives only in the secret stores: not in the saved config, not in either vault, not in the hub.
    const filesUnder = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(root, e.name)) : [join(root, e.name)]);
    const leaked = [store, a.vault, b.vault].flatMap(filesUnder).filter(file => readFileSync(file).includes(HTTP_TEST_TOKEN));
    expect(leaked).toEqual([]);
    expect(JSON.stringify(await a.provider.getConfig())).not.toContain(HTTP_TEST_TOKEN);
    expect(a.secrets.entries.get(hubTokenKey(url))).toBe(HTTP_TEST_TOKEN);
    await a.close(); await b.close();
  });

  it("a wrong token fails retryably with a hint and changes nothing on either side", async () => {
    const { url, make, server } = await setup("not-the-right-token-not-the-right-token");
    const a = make("a");
    a.write("Home.md", "home");
    await a.configureUnchecked({ kind: "http", url }, true);
    await expect(a.provider.probe(new AbortController().signal)).rejects.toMatchObject({ code: "unavailable", hint: expect.stringMatching(/URL and token/) });
    expect(server.connections()).toBe(0);
    expect(a.read("Home.md")).toBe("home");
    await a.close();
  });

  it("a missing token (secure storage emptied) asks for the token instead of reporting a network failure", async () => {
    const { url, make } = await setup();
    const a = make("a");
    a.secrets.entries.clear();
    await a.configureUnchecked({ kind: "http", url });
    await expect(a.provider.probe(new AbortController().signal)).rejects.toMatchObject({ code: "invalid-request", hint: expect.stringMatching(/Enter the hub token/) });
    await a.close();
  });

  it("probe lists the hub vault over WebSocket", async () => {
    const { url, make } = await setup();
    const a = make("a");
    await a.configureUnchecked({ kind: "http", url }, true);
    expect((await a.provider.probe(new AbortController().signal)).vaults).toEqual([]);
    await a.connect({ create: "Wiki" });
    const probe = await a.provider.probe(new AbortController().signal);
    expect(probe.vaults.map(v => v.name)).toEqual(["Wiki"]);
    expect(probe.detail).toMatch(/WebSocket/);
    await a.close();
  });
});

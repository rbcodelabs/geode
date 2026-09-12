import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distribution, deadline } from "../../scripts/large-vault-sample.mjs";
import { pairedSummary, runChild, stageDependencies } from "../../scripts/large-vault-runner-lib.mjs";
describe("external benchmark contracts", () => {
    it("arms OS ownership before allowing sample code to execute", async () => {
        const { collectProcessGroupRss } = await import("../../scripts/large-vault-runner-lib.mjs");
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-arm-test-")));
        try {
            const script = join(root, "run.mjs"), resultFile = join(root, "result.json");
            await writeFile(script, `import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],JSON.stringify({status:'ok',executedAt:Date.now()}));`);
            let checked = false;
            const result = await runChild({ script, args: [resultFile], cwd: root, resultFile, logFile: join(root, "log"), timeoutMs: 5000, collectRss: async (pid: number, tracker: unknown) => {
                if (!checked) { expect(await readdir(root)).not.toContain("result.json"); checked = true; }
                return collectProcessGroupRss(pid, tracker);
            } });
            expect(checked).toBe(true); expect(result.status).toBe("ok");
            const guard = JSON.parse(await readFile(resultFile + ".guard.json", "utf8"));
            expect(guard.armedAt).toBeTypeOf("number");
            expect(result.result.executedAt).toBeGreaterThanOrEqual(guard.armedAt);
        } finally { await rm(root, { recursive: true, force: true }); }
    }, 10000);
    it("cleans a verified detached group after its sample parent exits", async () => {
        const { collectProcessGroupRss } = await import("../../scripts/large-vault-runner-lib.mjs");
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-detached-test-")));
        try {
            const script = join(root, "spawn.mjs"), resultFile = join(root, "result.json"), marker = join(root, "observed");
            await writeFile(script, `import{spawn}from'node:child_process';import{writeFileSync,existsSync}from'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});writeFileSync(process.argv[2],JSON.stringify({status:'running',pid:c.pid,phaseStartedAt:Date.now()}));setInterval(()=>{if(existsSync(process.argv[3]))process.exit(7)},10);`);
            const result = await runChild({ script, args: [resultFile, marker], cwd: root, resultFile, logFile: join(root, "log"), timeoutMs: 5000, collectRss: async (pid: number, tracker: unknown) => {
                const sample = await collectProcessGroupRss(pid, tracker);
                if (sample.groups.length > 1) await writeFile(marker, "observed");
                return sample;
            } });
            expect(result.code).toBe(7);
            expect(result.status).toBe("interrupted");
            await vi.waitFor(() => expect(() => process.kill(result.result.pid, 0)).toThrow());
        } finally { await rm(root, { recursive: true, force: true }); }
    }, 10000);
    it("default adapter waits for renderer terminal receipt and its queued apply", async () => {
        const { awaitTerminalReadiness } = await import("../../scripts/large-vault-sample.mjs");
        let release!: () => void;
        const applied = new Promise<void>(resolve => { release = resolve; });
        const cache = { backgroundSnapshot: null as object | null, snapshotReceiving: true, waitForBackgroundIdle: vi.fn(() => applied) };
        vi.stubGlobal("window", { geode: { startMetadataIndexer: async () => true }, app: { metadataCache: cache } });
        try {
            let complete = false;
            const pending = awaitTerminalReadiness().then(() => { complete = true; });
            await Promise.resolve();
            expect(cache.waitForBackgroundIdle).not.toHaveBeenCalled();
            cache.backgroundSnapshot = { entries: {} };
            cache.snapshotReceiving = false;
            await vi.waitFor(() => expect(cache.waitForBackgroundIdle).toHaveBeenCalledOnce());
            expect(complete).toBe(false);
            release(); await pending;
            expect(complete).toBe(true);
        } finally { vi.unstubAllGlobals(); }
    });
    it("retains detached descendants after reparenting but excludes reused identities", async () => {
        const { OwnedProcessGroups } = await import("../../scripts/large-vault-runner-lib.mjs");
        const tracker = new OwnedProcessGroups(100);
        const p = (pid: number, ppid: number, pgid: number, started: string) => ({ pid, ppid, pgid, started, rssKiB: 1024 });
        expect(tracker.observe([p(100, 1, 100, "root"), p(101, 100, 101, "electron"), p(102, 101, 101, "renderer"), p(200, 1, 200, "other")]).groups).toEqual([100, 101]);
        expect(tracker.observe([p(101, 1, 101, "electron"), p(102, 101, 101, "renderer"), p(200, 1, 200, "other")]).groups).toEqual([101]);
        expect(tracker.observe([p(101, 1, 101, "reused"), p(200, 1, 200, "other")]).groups).toEqual([]);
    });
    it("waits for terminal indexing, then newly queued background work", async () => {
        const sample = await import("../../scripts/large-vault-sample.mjs");
        const order: string[] = [];
        let release!: (value: boolean) => void;
        const terminal = new Promise<boolean>(resolve => { release = resolve; });
        const pending = sample.awaitTerminalReadiness({
            startMetadataIndexer: () => { order.push("start"); return terminal; },
            waitForBackgroundIdle: async () => { order.push("idle"); },
        });
        await Promise.resolve();
        expect(order).toEqual(["start"]);
        release(true);
        await pending;
        expect(order).toEqual(["start", "idle"]);
        await expect(sample.awaitTerminalReadiness({ startMetadataIndexer: async () => null, waitForBackgroundIdle: async () => {} })).rejects.toThrow("unavailable");
    });
    it("counts only the owned POSIX group and rejects malformed RSS", async () => {
        const lib = await import("../../scripts/large-vault-runner-lib.mjs");
        expect(lib.parseProcessGroupRss("100 100 1024\n101 100 2048\n200 200 999999", 100)).toEqual({ processes: [{ pid: 100, pgid: 100, rssKiB: 1024 }, { pid: 101, pgid: 100, rssKiB: 2048 }], totalRssMiB: 3 });
        expect(lib.parseProcessGroupRss("200 200 999999", 100).totalRssMiB).toBe(0);
        expect(() => lib.parseProcessGroupRss("100 100 NaN", 100)).toThrow();
    });
    it("fails closed on a blocked child exceeding the parent RSS cap", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-rss-test-")));
        try {
            const script = join(root, "blocked.mjs"), resultFile = join(root, "result.json");
            await writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({status:'running',phaseStartedAt:Date.now()}));while(true){}`);
            const result = await runChild({ script, args: [resultFile], cwd: root, resultFile, logFile: join(root, "log"), timeoutMs: 5000, maxRssMiB: 1 });
            expect(result.status).toBe("resource-limit");
            expect(result.result.guard.reason).toMatch(/RSS/);
            expect(result.signal).toBe("SIGKILL");
        } finally { await rm(root, { recursive: true, force: true }); }
    }, 10000);
    it("stops after three consecutive collector errors and retains evidence", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-monitor-test-")));
        try {
            const script = join(root, "blocked.mjs"), resultFile = join(root, "result.json");
            await writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({status:'running',phaseStartedAt:Date.now(),phases:{cold:{status:'ok'}}}));while(true){}`);
            let failures = 0;
            const { collectProcessGroupRss } = await import("../../scripts/large-vault-runner-lib.mjs");
            const result = await runChild({ script, args: [resultFile], cwd: root, resultFile, logFile: join(root, "log"), timeoutMs: 5000, collectRss: async (pid: number, tracker: unknown) => {
                if (!(await readdir(root)).includes("result.json")) return collectProcessGroupRss(pid, tracker);
                failures++;
                throw Error("collector denied");
            } });
            expect(result.status).toBe("monitoring-unavailable");
            expect(failures).toBe(3);
            expect(JSON.parse(await readFile(resultFile + ".guard.json", "utf8")).errors).toHaveLength(3);
            expect(result.result.phases.cold.status).toBe("ok");
        } finally { await rm(root, { recursive: true, force: true }); }
    }, 10000);
    it("does not execute sample code without verified root ownership", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-unowned-test-")));
        try {
            const script = join(root, "run.mjs"), resultFile = join(root, "result.json");
            await writeFile(script, `import{writeFileSync}from'node:fs';writeFileSync(process.argv[2]+'.executed','yes');setInterval(()=>{},1000);`);
            let calls = 0;
            const result = await runChild({ script, args: [resultFile], cwd: root, resultFile, logFile: join(root, "log"), timeoutMs: 5000, collectRss: async () => {
                if (++calls <= 2) return { processes: [], groups: [], totalRssMiB: 0 };
                throw Error("collector denied");
            } });
            expect(result.status).toBe("monitoring-unavailable");
            expect(await readdir(root)).not.toContain("result.json.executed");
            const guard = JSON.parse(await readFile(resultFile + ".guard.json", "utf8"));
            expect(guard.errors).toHaveLength(3);
            expect(guard.armedAt).toBeUndefined();
        } finally { await rm(root, { recursive: true, force: true }); }
    }, 10000);
    it("freezes relocatable dependencies independently and refuses escaping links", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-dependency-test-")));
        try {
            const source = join(root, "source"), target = join(root, "target");
            await mkdir(source);
            await writeFile(join(source, "module.js"), "export const value=1;");
            await symlink("module.js", join(source, "link.js"));
            const inventory = await stageDependencies(source, target);
            expect(inventory.files).toBe(1);
            expect(inventory.sha256).toMatch(/^[a-f0-9]{64}$/);
            await writeFile(join(source, "module.js"), "changed");
            expect(await readFile(join(target, "module.js"), "utf8")).toBe("export const value=1;");
            await symlink("../target/module.js", join(source, "escape.js"));
            await expect(stageDependencies(source, join(root, "unsafe"))).rejects.toThrow("escapes");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it("reports raw samples, median and nearest-rank p95 without sorting caller data", () => {
        const samples = [3, 1, 2];
        expect(distribution(samples)).toEqual({ samples, median: 2, p95: 3 });
        expect(samples).toEqual([3, 1, 2]);
        expect(distribution([])).toEqual({ samples: [], median: null, p95: null });
    });
    it("records an explicit phase deadline instead of waiting forever", async () => {
        await expect(deadline(() => new Promise(() => { }), 5, "fixture-phase")).rejects.toThrow("fixture-phase: phase timeout");
        expect(await deadline(async () => 42, 50, "quick")).toBe(42);
    });
    it("rejects invalid controller arguments before any worktree or output creation", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-invalid-runner-")));
        try {
            await Promise.all([["--pairs=0"], ["--unknown=x"], ["--sizes=NaN"], ["--profile=dense"]].map(async (args, index) => {
                await expect(promisify(execFile)(process.execPath, ["scripts/run-large-vault-benchmark.mjs", `--output=${join(root, `output-${index}`)}`, ...args])).rejects.toThrow();
            }));
            expect(await readdir(root)).toEqual([]);
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it("kills a synchronously blocked child per phase and retains its checkpoint", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-watchdog-test-")));
        try {
            const script = join(root, "blocked.mjs"), resultFile = join(root, "result.json");
            await writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({status:'running',activePhase:'blocked',phaseStartedAt:Date.now(),phases:{cold:{status:'ok',launchThroughReadyMs:3}}}));while(true){}`);
            const result = await runChild({ script, args: [resultFile], cwd: root, resultFile, logFile: join(root, "log"), timeoutMs: 2000 });
            expect(result.status).toBe("timeout");
            expect(result.signal).toBe("SIGKILL");
            expect(JSON.parse(await readFile(resultFile + ".last-checkpoint.json", "utf8")).activePhase).toBe("blocked");
            expect(result.result.phases.cold.status).toBe("ok");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 10000);
    it("normalizes an abruptly exited child to interrupted and preserves phase success", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "stress-interrupted-test-")));
        try {
            const script = join(root, "exit.mjs"), resultFile = join(root, "result.json");
            await writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({status:'running',phaseStartedAt:Date.now()}));process.exit(7);`);
            const result = await runChild({ script, args: [resultFile], cwd: root, resultFile, logFile: join(root, "log"), timeoutMs: 2000 });
            expect(result.status).toBe("interrupted");
            expect(result.code).toBe(7);
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it("compares successful phases from partial samples without inventing missing measurements", () => {
        const samples = [{ workload: "w", pair: 0, label: "baseline", result: { status: "failed", phases: { cold: { status: "ok", launchThroughReadyMs: 10 } } } }, { workload: "w", pair: 0, label: "candidate", result: { status: "ok", phases: { cold: { status: "ok", launchThroughReadyMs: 15 } } } }];
        expect(pairedSummary(samples, "w")).toEqual([{ name: "cold ms", absolute: [5], relative: [50] }]);
    });
});

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distribution, deadline } from "../../scripts/large-vault-sample.mjs";
import { pairedSummary, runChild, stageDependencies } from "../../scripts/large-vault-runner-lib.mjs";
describe("external benchmark contracts", () => {
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
            for (const args of [["--pairs=0"], ["--unknown=x"], ["--sizes=NaN"], ["--profile=dense"]])
                expect(() => execFileSync(process.execPath, ["scripts/run-large-vault-benchmark.mjs", `--output=${join(root, "output")}`, ...args], { stdio: "pipe" })).toThrow();
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

import { spawn, execFile } from "node:child_process";
import { totalmem } from "node:os";
import { promisify } from "node:util";
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, statfs, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { distribution } from "./large-vault-metrics.mjs";
/** Parent-owned watchdog: still runs while the child executes synchronous JS. */
const execFileAsync = promisify(execFile);
/** Identity-checked descendant groups survive reparenting, never PID reuse. */
export class OwnedProcessGroups {
    constructor(rootPid) { this.rootPid = rootPid; this.identities = new Map(); this.started = false; }
    observe(rows) {
        const owned = new Set(rows.filter(p => this.identities.get(p.pid) === p.started).map(p => p.pid));
        if (!this.started) {
            const root = rows.find(p => p.pid === this.rootPid);
            if (root) { owned.add(root.pid); this.started = true; }
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of rows) if (!owned.has(p.pid) && owned.has(p.ppid)) { owned.add(p.pid); changed = true; }
        }
        const groups = [...new Set(rows.filter(p => owned.has(p.pid)).map(p => p.pgid))].sort((a,b) => a-b);
        // A group remains owned while an identity-verified member survives.
        const processes = rows.filter(p => groups.includes(p.pgid));
        for (const p of processes) this.identities.set(p.pid, p.started);
        return { processes, groups, totalRssMiB: processes.reduce((n,p) => n+p.rssKiB,0)/1024 };
    }
}
export function parseProcessGroupRss(text, pgid) {
    const processes = [];
    for (const line of text.trim().split("\n")) {
        if (!line.trim()) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 3 || parts.some(v => !/^\d+$/.test(v))) throw Error("Invalid POSIX process RSS row");
        const [pid, group, rssKiB] = parts.map(Number);
        if (![pid, group, rssKiB].every(Number.isSafeInteger)) throw Error("Invalid POSIX process RSS value");
        if (group === pgid) processes.push({ pid, pgid: group, rssKiB });
    }
    return { processes, totalRssMiB: processes.reduce((sum, p) => sum + p.rssKiB, 0) / 1024 };
}
export async function collectProcessGroupRss(pgid, tracker = new OwnedProcessGroups(pgid)) {
    if (!['darwin', 'linux'].includes(process.platform)) throw Error("POSIX RSS monitoring unsupported on this platform");
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,lstart='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
    const rows = stdout.trim().split('\n').filter(line => line.trim()).map(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!match) throw Error('Invalid POSIX identity/RSS row');
        const [pid, ppid, group, rssKiB] = match.slice(1,5).map(Number);
        if (![pid,ppid,group,rssKiB].every(Number.isSafeInteger)) throw Error('Invalid POSIX identity/RSS value');
        return { pid, ppid, pgid: group, rssKiB, started: match[5] };
    });
    return tracker.observe(rows);
}
export async function preflightRssMonitoring() { await collectProcessGroupRss(-1); }
export async function runChild({ script, args, cwd, resultFile, logFile, timeoutMs, maxRssMiB = totalmem() / 2 / 1024 ** 2, collectRss = collectProcessGroupRss }) {
    if (!Number.isFinite(maxRssMiB) || maxRssMiB <= 0) throw Error("Invalid RSS safety limit");
    const log = await open(logFile, "wx");
    let child, timedOut = false, cancelled, guardFailure, tracker, killPromise;
    const guard = { metric: "owned POSIX process-group summed RSS MiB (sample Node + Electron descendants)", maxRssMiB, samples: [], errors: [], registrations: [], coverage: 'OS polling cannot discover descendants born and reparented entirely between polls; no complete-containment claim' };
    let saveGuard = Promise.resolve();
    const persistGuard = () => {
        const checkpoint = JSON.stringify(guard, null, 2);
        saveGuard = saveGuard.then(() => writeFile(resultFile + '.guard.json', checkpoint)).catch(error => {
            guardFailure = { status: 'monitoring-unavailable', reason: `Guard evidence write failed: ${String(error)}` };
            void kill();
        });
    };
    function kill() {
        if (!child?.pid) return Promise.resolve();
        if (killPromise) return killPromise;
        killPromise = (async () => {
            try {
                // Revalidate identities immediately before signalling; never use
                // an old PGID after its members have disappeared/reused PIDs.
                const current = await collectProcessGroupRss(child.pid, tracker);
                for (const group of [...current.groups.filter(g => g !== child.pid), child.pid]) {
                    if (!current.groups.includes(group)) continue;
                    try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                }
            } catch (error) {
                guard.cleanupError = String(error);
                // The ChildProcess handle is owned even if OS discovery fails;
                // do not guess identities of detached groups in this case.
                child.kill('SIGKILL');
            }
        })();
        return killPromise;
    }
    const cancel = signal => { cancelled = signal; kill(); };
    const interrupt = () => cancel("SIGINT"), terminate = () => cancel("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
        const exit = await new Promise(resolve => {
            const bootstrap = `import {pathToFileURL} from 'node:url';const armed=new Promise(resolve=>process.once('message',resolve));process.send({type:'bootstrap-ready'});await armed;await import(pathToFileURL(process.argv[1]).href);if(process.connected)process.disconnect();`;
            child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap, script, ...args], { cwd, detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd, 'ipc'] });
            tracker = new OwnedProcessGroups(child.pid);
            let stopped = false, collecting = false, consecutiveErrors = 0, bootstrapReady = false;
            const sampleRss = async () => {
                if (stopped || collecting || guardFailure) return;
                collecting = true;
                try {
                    const value = await collectRss(child.pid, tracker);
                    if (stopped) return;
                    guard.samples.push({ at: Date.now(), ...value });
                    consecutiveErrors = 0;
                    if (value.totalRssMiB > maxRssMiB) guardFailure = { status: 'resource-limit', reason: `Parent RSS limit exceeded (${maxRssMiB} MiB)` };
                    const rootOwned = value.processes.some(p => p.pid === child.pid && tracker.identities.get(p.pid) === p.started);
                    if (!guardFailure && rootOwned && bootstrapReady && !guard.armedAt) {
                        guard.armedAt = Date.now();
                        child.send({ type: 'monitor-armed' }, error => {
                            if (error && !stopped) { guardFailure = { status: 'monitoring-unavailable', reason: `Monitor handshake failed: ${String(error)}` }; void kill(); }
                        });
                    }
                    for (const registration of guard.registrations) {
                        const owned = value.processes.find(p => p.pid === registration.pid);
                        if (owned && !registration.verifiedAt) Object.assign(registration, { verifiedAt: Date.now(), identity: owned });
                    }
                } catch (error) {
                    if (stopped) return;
                    guard.errors.push({ at: Date.now(), error: String(error) });
                    if (++consecutiveErrors >= 3) guardFailure = { status: 'monitoring-unavailable', reason: 'Three consecutive parent RSS collection failures' };
                } finally {
                    collecting = false;
                    if (!stopped) {
                        Object.assign(guard, guardFailure ?? {});
                        persistGuard();
                        if (guardFailure) kill();
                    }
                }
            };
            const rssTimer = setInterval(() => { void sampleRss(); }, 500);
            child.on('message', message => {
                if (message?.type === 'bootstrap-ready') { bootstrapReady = true; void sampleRss(); return; }
                if (message?.type !== 'electron-process' || !Number.isSafeInteger(message.pid) || message.pid <= 0) return;
                // This is a hint from the owned harness, never authority to kill.
                // Only OS ancestry/identity verification admits the group.
                guard.registrations.push({ pid: message.pid, at: Date.now() });
                void sampleRss();
            });
            void sampleRss();
            let watchedAt = Date.now(), polling = false;
            const timer = setInterval(async () => {
                if (polling || timedOut)
                    return;
                polling = true;
                try {
                    const checkpoint = JSON.parse(await readFile(resultFile, "utf8"));
                    if (Number.isFinite(checkpoint.phaseStartedAt))
                        watchedAt = checkpoint.phaseStartedAt;
                }
                catch { }
                if (Date.now() - watchedAt > timeoutMs) {
                    timedOut = true;
                    kill();
                }
                polling = false;
            }, 250);
            const stop = () => { stopped = true; clearInterval(timer); clearInterval(rssTimer); };
            child.once("error", error => { stop(); resolve({ code: null, signal: null, spawnError: String(error) }); });
            child.once("exit", (code, signal) => { stop(); resolve({ code, signal }); });
        });
        // Playwright's Electron process has its own group. Reap verified owned
        // survivors even when the sample exits before explicitly closing it.
        await kill();
        guard.cleanupUncertainty = !!guard.cleanupError || guardFailure?.status === 'monitoring-unavailable' || guard.registrations.some(r => !r.verifiedAt);
        if (guard.cleanupError) guardFailure = { status: 'monitoring-unavailable', reason: `Owned descendant cleanup could not be verified: ${guard.cleanupError}` };
        Object.assign(guard, guardFailure ?? {});
        persistGuard();
        await saveGuard;
        let result;
        try {
            result = JSON.parse(await readFile(resultFile, "utf8"));
        }
        catch { }
        if (guardFailure || timedOut || cancelled || !result || result.status === "running" || exit.code !== 0 && result.status === "ok") {
            await writeFile(resultFile + ".last-checkpoint.json", JSON.stringify(result ?? null, null, 2));
            result = { ...result, status: guardFailure?.status ?? (timedOut ? "timeout" : "interrupted"), error: guardFailure?.reason ?? (timedOut ? "Parent phase deadline" : "Child did not finish cleanly"), ...exit, cancelled, guard: { ...guardFailure, file: resultFile + '.guard.json' } };
            await writeFile(resultFile, JSON.stringify(result, null, 2));
        }
        return { ...exit, result, status: result.status, cancelled };
    }
    finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
        await log.close();
    }
}
/** Include valid phases from partial samples; never treat absent metrics as 0. */
export function metrics(result) {
    const values = {};
    const p = result?.phases ?? {};
    for (const [phase, field, label] of [["cold", "launchThroughReadyMs", "cold ms"], ["warm", "launchThroughReadyMs", "warm ms"], ["incremental", "convergenceMs", "incremental ms"], ["nodeSnapshot", "constructionMs", "Node construction ms"]])
        if (p[phase]?.status === "ok")
            values[label] = p[phase][field];
    if (p.navigation?.status === "ok") {
        values["click median ms"] = p.navigation.clickThroughRenderedDestinationMs.median;
        values["click p95 ms"] = p.navigation.clickThroughRenderedDestinationMs.p95;
    }
    for (const phase of ["desktopResolution", "nodeSnapshot"])
        if (p[phase]?.status === "ok")
            for (const category of p[phase].categories ?? [])
                values[`${phase} ${category.category} batch median ms`] = distribution(category.samplesMs).median;
    for (const [phase, memory] of Object.entries(result?.memory?.byPhase ?? {})) {
        if (p[phase]?.status !== "ok")
            continue;
        values[`${phase} total working-set peak MiB`] = memory.peakMiB;
        values[`${phase} total working-set settled MiB`] = memory.settledMiB;
        for (const [type, value] of Object.entries(memory.byType))
            values[`${phase} ${type} working-set peak MiB`] = value.peakMiB;
    }
    if (result?.status === "ok" && result?.rendererLagMs)
        values["renderer lag p95 ms"] = result.rendererLagMs.p95;
    return values;
}
export function pairedSummary(samples, workload) {
    const rows = samples.filter(s => s.workload === workload);
    const names = new Set(rows.flatMap(s => Object.keys(metrics(s.result))));
    return [...names].map(name => {
        const absolute = [], relative = [];
        for (const pair of new Set(rows.map(s => s.pair))) {
            const a = metrics(rows.find(s => s.pair === pair && s.label === "baseline")?.result)[name];
            const b = metrics(rows.find(s => s.pair === pair && s.label === "candidate")?.result)[name];
            if (Number.isFinite(a) && Number.isFinite(b)) {
                absolute.push(b - a);
                if (a > 0)
                    relative.push((b / a - 1) * 100);
            }
        }
        return { name, absolute, relative };
    });
}
const cacheNames = new Set([".cache", ".vite", ".vite-temp"]);
/** Fingerprint file bytes and link text; reject dependencies escaping the tree. */
export async function dependencyInventory(directory) {
    const root = await realpath(directory), hash = createHash("sha256");
    let files = 0, bytes = 0;
    async function walk(folder) {
        for (const name of (await readdir(join(root, folder))).sort()) {
            if (cacheNames.has(name))
                continue;
            const path = folder ? folder + "/" + name : name, full = join(root, path), stat = await lstat(full);
            hash.update(path + "\0");
            if (stat.isSymbolicLink()) {
                const target = await readlink(full), actual = await realpath(full), suffix = relative(root, actual);
                if (isAbsolute(target) || suffix.startsWith("..") || isAbsolute(suffix))
                    throw Error(`Dependency symlink escapes relocatable tree: ${path}`);
                hash.update("link\0" + target + "\0");
            }
            else if (stat.isDirectory()) {
                hash.update("directory\0");
                await walk(path);
            }
            else if (stat.isFile()) {
                hash.update("file\0");
                for await (const chunk of createReadStream(full))
                    hash.update(chunk);
                hash.update("\0");
                files++;
                bytes += stat.size;
            }
            else
                throw Error(`Unsupported dependency entry: ${path}`);
        }
    }
    await walk("");
    return { sha256: hash.digest("hex"), files, bytes, excludedCacheDirectories: [...cacheNames] };
}
export async function stageDependencies(source, destination) {
    const canonical = await realpath(source), original = await dependencyInventory(canonical);
    const available = await statfs(dirname(destination)).then(s => s.bavail * s.bsize);
    if (available < 5 * 1024 ** 3 + original.bytes)
        throw Error("Insufficient disk headroom for private dependencies");
    await mkdir(destination);
    await cp(canonical, destination, { recursive: true, verbatimSymlinks: true, filter: path => !relative(canonical, path).split(/[\\/]/).some(name => cacheNames.has(name)) });
    const staged = await dependencyInventory(destination);
    const after = await dependencyInventory(source);
    if (staged.sha256 !== original.sha256 || after.sha256 !== original.sha256)
        throw Error("Dependencies changed while staging; preserve output and rerun after installs stop");
    return staged;
}

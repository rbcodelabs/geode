import { spawn } from "node:child_process";
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, statfs, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { distribution } from "./large-vault-sample.mjs";
/** Parent-owned watchdog: still runs while the child executes synchronous JS. */
export async function runChild({ script, args, cwd, resultFile, logFile, timeoutMs }) {
    const log = await open(logFile, "wx");
    let child, timedOut = false, cancelled;
    function kill() {
        if (!child?.pid) return;
        try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    }
    const cancel = signal => { cancelled = signal; kill(); };
    const interrupt = () => cancel("SIGINT"), terminate = () => cancel("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
        const exit = await new Promise(resolve => {
            child = spawn(process.execPath, [script, ...args], { cwd, detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd] });
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
            child.once("error", error => { clearInterval(timer); resolve({ code: null, signal: null, spawnError: String(error) }); });
            child.once("exit", (code, signal) => { clearInterval(timer); resolve({ code, signal }); });
        });
        let result;
        try {
            result = JSON.parse(await readFile(resultFile, "utf8"));
        }
        catch { }
        if (timedOut || cancelled || !result || result.status === "running" || exit.code !== 0 && result.status === "ok") {
            await writeFile(resultFile + ".last-checkpoint.json", JSON.stringify(result ?? null, null, 2));
            result = { ...result, status: timedOut ? "timeout" : "interrupted", error: timedOut ? "Parent phase deadline" : "Child did not finish cleanly", ...exit, cancelled };
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

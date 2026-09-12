import { execFileSync } from "node:child_process";
import { cp, readFile, writeFile, symlink, mkdir, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { createRequire } from "node:module";
import { freshDirectory, generateSyntheticVault, verifySyntheticVault } from "./synthetic-vault.mts";
import { distribution } from "./large-vault-sample.mjs";
import { pairedSummary, runChild, stageDependencies } from "./large-vault-runner-lib.mjs";
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptRoot, "..");
const values = {};
for (const arg of process.argv.slice(2)) {
    const match = /^--(output|fixture|baseline|candidate|sizes|profiles|pairs|phase-minutes|control-notes|control-pairs|max-working-set-mib)=(.+)$/.exec(arg);
    if (!match || match[1] in values)
        throw Error("Expected unique --output=/fresh/absolute/path [--sizes=10000,50000 --profiles=linked,dense --pairs=3 --phase-minutes=15 --control-notes=100]");
    values[match[1]] = match[2];
}
if (!values.output)
    throw Error("--output is required; the parent directory must already exist without symlink ancestors");
const sizes = (values.sizes ?? "10000,50000").split(",").map(Number);
const profiles = (values.profiles ?? "linked,dense").split(",");
const pairs = Number(values.pairs ?? 3), timeoutMs = Number(values["phase-minutes"] ?? 15) * 60000, controlNotes = Number(values["control-notes"] ?? 100);
const controlPairs = Number(values["control-pairs"] ?? 3), maxWorkingSetMiB = Number(values["max-working-set-mib"] ?? Math.floor(totalmem() / 1024 ** 2 / 2));
if (!Number.isInteger(controlPairs) || controlPairs < 1 || controlPairs > 10 || !Number.isFinite(maxWorkingSetMiB) || maxWorkingSetMiB <= 0)
    throw Error("Invalid control-pairs/max-working-set-mib");
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000)
    throw Error("Invalid pairs/phase-minutes");
for (const size of [...sizes, controlNotes])
    if (!Number.isInteger(size) || size < 20 || size > 100000)
        throw Error("sizes/control-notes must be20..100000");
if (profiles.some(p => !["linked", "dense"].includes(p)))
    throw Error("profiles must be linked,dense");
const reusedManifest = values.fixture ? await verifySyntheticVault(values.fixture) : null;
const git = (args, root = repository) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const revisions = { baseline: git(["rev-parse", "--verify", `${values.baseline ?? "c45ebee9c172b4020620c5d63e53acbddff5d46b"}^{commit}`]), candidate: git(["rev-parse", "--verify", `${values.candidate ?? "68d7b5353bdd5b960629d422e96c2a4223761085"}^{commit}`]) };
const output = await freshDirectory(values.output);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: "running", revisions, configuration: { sizes, profiles, pairs, timeoutMs, controlNotes, controlPairs, maxWorkingSetMiB }, environment: { node: process.version, nodeExecArgv: process.execArgv, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cpuCount: cpus().length, totalMemory: totalmem(), freeMemory: freemem() }, samples: [] };
const save = async () => { await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n"); await writeFile(join(output, "report.md"), markdown(report)); };
function markdown(report) {
    const lines = ["# Synthetic vault measurements", "", `Status: ${report.status}. No performance threshold.`, "", `Baseline: ${report.revisions.baseline}; candidate: ${report.revisions.candidate}.`, "", "Cold means application cache, not OS cache. Memory is summed process working set, not unique physical memory. Source fixture generation/build/copy excluded. Failed samples are retained, never retried or substituted.", "", "| Workload | Label | Pair | Status | Cold ms | Warm ms | Click median/p95 ms |", "|---|---|---:|---|---:|---:|---|"];
    for (const s of report.samples) {
        const p = s.result?.phases ?? {};
        const nav = p.navigation?.clickThroughRenderedDestinationMs;
        lines.push(`| ${s.workload} | ${s.label} | ${s.pair} | ${s.result?.status ?? s.status} | ${p.cold?.launchThroughReadyMs?.toFixed(1) ?? "—"} | ${p.warm?.launchThroughReadyMs?.toFixed(1) ?? "—"} | ${nav ? `${nav.median.toFixed(1)} / ${nav.p95.toFixed(1)}` : "—"} |`);
    }
    lines.push("", "## Paired changes", "", "Positive values mean candidate is higher. Valid phases from partial samples remain included; missing/failed phases are never zero. Control labels are the SAME candidate revision: their spread exposes machine/OS/order noise, not code regression. The first cold sample is retained. No regression acceptance threshold.", "", "| Workload | Metric | Valid pairs | Absolute delta median [min,max] | Relative delta median [min,max] |", "|---|---|---:|---|---|");
    for (const workload of new Set(report.samples.map(s => s.workload))) {
        for (const { name, absolute, relative } of pairedSummary(report.samples, workload)) {
            const format = v => v.length ? `${distribution(v).median.toFixed(2)} [${Math.min(...v).toFixed(2)}, ${Math.max(...v).toFixed(2)}]` : "—";
            lines.push(`| ${workload} | ${name} | ${absolute.length} | ${format(absolute)} | ${format(relative)}% |`);
        }
    }
    lines.push("", "Full raw samples, category distributions, memory samples, phase failures, environment and fixture digests are in report.json and per-sample files. Node graph coverage remains wikilink-only; Markdown examples are not a parity claim.", "");
    return lines.join("\n");
}
async function child(config, id) {
    const configFile = join(output, `${id}.config.json`), resultFile = join(output, `${id}.json`);
    await writeFile(configFile, JSON.stringify({ ...config, resultFile }));
    return runChild({ script: join(output, "harness", "large-vault-sample.mjs"), args: ["--config", configFile], cwd: repository, resultFile, logFile: join(output, `${id}.log`), timeoutMs });
}
try {
    report.environment.lockSha256 = hash(await readFile(join(repository, "package-lock.json")));
    report.environment.playwright = JSON.parse(await readFile(join(repository, "node_modules/@playwright/test/package.json"), "utf8")).version;
    report.environment.electron = JSON.parse(await readFile(join(repository, "node_modules/electron/package.json"), "utf8")).version;
    report.environment.disk = await statfs(output).then(s => ({ freeBytes: s.bavail * s.bsize }));
    report.environment.dependencies = await stageDependencies(join(repository, "node_modules"), join(output, "node_modules"));
    const { build } = createRequire(join(output, "runner.cjs"))("esbuild");
    await mkdir(join(output, "harness"));
    report.environment.harness = {};
    for (const file of ["large-vault-sample.mjs", "synthetic-vault.mts"]) {
        const bytes = await readFile(join(scriptRoot, file));
        report.environment.harness[file] = hash(bytes);
        await writeFile(join(output, "harness", file), bytes);
    }
    const roots = {};
    const bundles = {};
    for (const label of ["baseline", "candidate"]) {
        roots[label] = join(output, `revision-${label}`);
        git(["worktree", "add", "--detach", roots[label], revisions[label]]);
        assertSame(await readFile(join(roots[label], "package-lock.json")), await readFile(join(repository, "package-lock.json")), "lockfile");
        assertSame(await readFile(join(roots[label], "package.json")), Buffer.from(git(["show", `${revisions.baseline}:package.json`]) + "\n"), "package.json");
        await symlink(join(output, "node_modules"), join(roots[label], "node_modules"), "dir");
        execFileSync(process.execPath, [join(roots[label], "esbuild.config.mjs")], { cwd: roots[label], stdio: "pipe", timeout: timeoutMs });
        bundles[label] = join(output, `snapshot-${label}.cjs`);
        await build({ entryPoints: [join(roots[label], "src/wiki/snapshot.ts")], outfile: bundles[label], bundle: true, platform: "node", format: "cjs", target: "node22" });
    }
    async function workload(name, notes, profile, control = false, reuse = false) {
        const sourceVault = reuse ? values.fixture : join(output, `fixture-${name}`);
        const manifest = reuse ? reusedManifest : await generateSyntheticVault(sourceVault, { notes, profile, seed: 1 });
        await verifySyntheticVault(sourceVault);
        for (let pair = 0; pair < (control ? controlPairs : pairs); pair++)
            for (const label of pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
                const revisionLabel = control ? "candidate" : label;
                const id = `${name}-${pair}-${label}`;
                const available = await statfs(output).then(s => s.bavail * s.bsize);
                if (available < 5 * 1024 ** 3 + manifest.stats.bytes * 4)
                    throw Error("Insufficient disk headroom (5GiB + four fixture sizes); remaining matrix stopped, evidence retained");
                const sampleDir = join(output, `sample-${id}`);
                await mkdir(sampleDir);
                const vault = join(sampleDir, "vault");
                await cp(sourceVault, vault, { recursive: true });
                await verifySyntheticVault(vault);
                const sample = { workload: name, pair, label, revision: revisions[revisionLabel], fixtureDigest: manifest.digest, status: "running" };
                report.samples.push(sample);
                await save();
                Object.assign(sample, await child({ revisionRoot: roots[revisionLabel], vault, userData: join(sampleDir, "userdata"), manifest, sourceVault, timeoutMs, maxWorkingSetMiB, snapshotBundle: bundles[revisionLabel] }, id));
                await verifySyntheticVault(sourceVault);
                sample.sourceDigestUnchanged = true;
                await save();
                if (sample.cancelled || sample.result?.status === "resource-limit")
                    throw Error("Sample cancelled/resource-limited; remaining matrix stopped");
                // Keep every sample copy (especially failed ones). The user owns this
                // explicit output tree; the tool never recursively deletes it.
            }
    }
    await workload("control", controlNotes, "linked", true);
    if (report.samples.some(s => s.result?.status !== "ok"))
        throw Error("Same-revision control failed; matrix not started");
    if (reusedManifest)
        await workload("reused-fixture", reusedManifest.options.notes, reusedManifest.options.profile, false, true);
    else
        for (const notes of sizes)
            for (const profile of profiles)
                await workload(`${notes}-${profile}`, notes, profile);
    report.status = report.samples.every(s => s.result?.status === "ok") ? "complete" : "complete-with-failures";
    if (report.status !== "complete")
        process.exitCode = 1;
}
catch (error) {
    report.status = "failed";
    report.error = String(error);
    process.exitCode = 1;
}
finally {
    report.finishedAt = new Date().toISOString();
    await save();
}
function assertSame(a, b, label) { if (!a.equals(b))
    throw Error(`Revision ${label} differs from the shared toolchain; refusing comparison`); }

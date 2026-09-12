import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";
import { graphFor, referencesFor, notePath, attachmentPath, incrementalDeletionIndex, incrementalGraphFor } from "./synthetic-vault.mts";
export const distribution = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
};
export async function deadline(run, milliseconds, label) {
    let timer;
    try {
        return await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label}: phase timeout after ${milliseconds}ms`)), milliseconds); })]);
    }
    finally {
        clearTimeout(timer);
    }
}
export async function runSample(config) {
    const { revisionRoot, vault, userData, manifest, timeoutMs, resultFile, snapshotBundle } = config;
    const report = { config, status: "running", phases: {}, memorySamples: [], errors: [] };
    const save = () => writeFile(resultFile, JSON.stringify(report, null, 2) + "\n");
    let app;
    let timer;
    let sampling = false;
    let resourceError;
    const deletionIndex=incrementalDeletionIndex(manifest.options);
    const deletionPath=notePath(deletionIndex);
    async function phase(name, fn) {
        const started = performance.now();
        report.activePhase = name;
        report.phaseStartedAt = Date.now();
        await save();
        try {
            const value = await deadline(fn, timeoutMs, name);
            await sampleMemory();
            if (resourceError)
                throw Error(resourceError);
            report.phases[name] = { status: "ok", ...value, elapsedMs: performance.now() - started };
        }
        catch (error) {
            report.phases[name] = { status: "failed", elapsedMs: performance.now() - started, error: String(error) };
            throw error;
        }
        finally {
            await save();
        }
    }
    const sampleMemory = async () => {
        if (!app || sampling)
            return;
        sampling = true;
        try {
            const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, workingSetMiB: (m.memory?.workingSetSize ?? 0) / 1024 })));
            report.memorySamples.push({ phase: report.activePhase, time: performance.now(), processes, totalWorkingSetMiB: processes.reduce((s, p) => s + p.workingSetMiB, 0) });
            if (report.memorySamples.at(-1).totalWorkingSetMiB > config.maxWorkingSetMiB) {
                resourceError = `Working-set safety limit exceeded: ${config.maxWorkingSetMiB}MiB`;
                await close();
            }
        }
        catch (error) {
            report.errors.push(`memory sample: ${String(error)}`);
        }
        finally {
            sampling = false;
        }
    };
    function expectedRow(i, modified) {
        return modified ? incrementalGraphFor(i,manifest.options) : graphFor(i,manifest.options);
    }
    async function verifyRows(page, rows) {
        await page.waitForFunction(rows => {
            const c = window.app.metadataCache;
            const equal = (a, b) => a && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v);
            return rows.every(row => equal(c.resolvedLinks[row.path], row.resolved) && equal(c.unresolvedLinks[row.path], row.missing));
        }, rows, { timeout: timeoutMs });
    }
    async function ready(page, modified = false) {
        await page.waitForFunction(({ count }) => {
            const a = window.app;
            return a?.workspace?.layoutReady && a.metadataCache.initialized && a.vault.getMarkdownFiles().length === count && Object.keys(a.metadataCache.resolvedLinks).length === count;
        }, { count: manifest.options.notes }, { timeout: timeoutMs });
        await page.evaluate(() => window.app.metadataCache.waitForBackgroundIdle());
        const readyAt = performance.now();
        // Validate every graph row, not only the number of known files: the utility
        // stream may finish after initialize() and waitForBackgroundIdle() return.
        const started = performance.now();
        for (let start = 0; start < manifest.options.notes; start += 100) {
            const expected = [];
            for (let i = start; i < Math.min(start + 100, manifest.options.notes); i++) {
                if (modified && i === deletionIndex)
                    continue;
                expected.push(expectedRow(i, modified));
            }
            await verifyRows(page, expected);
        }
        if (modified)
            await page.waitForFunction(deleted => {
                const c = window.app.metadataCache;
                return !c.resolvedLinks[deleted] && c.resolvedLinks["Incremental-added.md"]?.[window.__stressFirstNote] === 1;
            }, deletionPath, { timeout: timeoutMs });
        return { readyAt, graphValidationMs: performance.now() - started, validatedRows: manifest.options.notes };
    }
    async function launch() {
        const started = performance.now();
        app = await electron.launch({ args: [revisionRoot, `--user-data-dir=${userData}`], cwd: revisionRoot,
            env: { ...process.env, GEODE_HEADLESS: "1" }, timeout: timeoutMs });
        timer = setInterval(() => { void sampleMemory(); }, 250);
        const page = await app.firstWindow();
        report.runtime = await app.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }));
        page.on("pageerror", e => report.errors.push(`pageerror: ${String(e)}`));
        await page.evaluate(() => {
            window.__stressIndexer = [];
            window.geode.onMetadataIndexerMessage(message => { window.__stressIndexer.push({ type: message.type, at: performance.now() }); });
            window.__stressLag = [];
            let last = performance.now();
            setInterval(() => { const now = performance.now(); window.__stressLag.push(Math.max(0, now - last - 25)); last = now; }, 25);
        });
        const validation = await ready(page);
        await sampleMemory();
        const { readyAt, ...verification } = validation;
        return { page, result: { launchThroughReadyMs: readyAt - started, ...verification } };
    }
    async function close() { clearInterval(timer); if (app) {
        await app.close();
        app = undefined;
    } }
    try {
        await mkdir(userData);
        await writeFile(join(userData, "geode.json"), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));
        await phase("cold", async () => {
            const { page, result } = await launch();
            result.rendererLagMs = distribution(await page.evaluate(() => window.__stressLag));
            result.indexerEvents = await page.evaluate(() => window.__stressIndexer);
            await close();
            return result;
        });
        let page;
        await phase("warm", async () => { const launched = await launch(); page = launched.page; return launched.result; });
        await phase("navigation", async () => {
            const times = [];
            for (const nav of manifest.navigation) {
                await page.evaluate(async (source) => { const a = window.app; await a.openFile(a.vault.getFileByPath(source)); }, nav.source);
                const toggle = page.getByRole("button", { name: /Toggle reading view/ });
                if (!(await page.locator(".markdown-reading-view:visible").count()))
                    await toggle.click();
                const link = page.locator('.markdown-reading-view:visible a.internal-link').filter({ hasText: "Next synthetic note" }).first();
                await link.waitFor({ state: "visible", timeout: timeoutMs });
                const started = performance.now();
                await link.click({ timeout: timeoutMs });
                await page.waitForFunction(target => window.app.workspace.getActiveFile()?.path === target, nav.target, { timeout: timeoutMs });
                await page.getByRole("heading", { name: nav.marker, exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
                times.push(performance.now() - started);
            }
            return { clickThroughRenderedDestinationMs: distribution(times) };
        });
        await phase("desktopResolution", async () => ({ categories: await page.evaluate(queries => queries.map(query => {
                const c = window.app.metadataCache;
                const path = c.getFirstLinkpathDest(query.link, query.source)?.path ?? null;
                if (path === null ? query.candidates.length !== 0 : !query.candidates.includes(path))
                    throw Error(`Resolution mismatch ${query.category}: ${path}`);
                const times = [];
                for (let j = 0; j < 1000; j++)
                    c.getFirstLinkpathDest(query.link, query.source);
                for (let round = 0; round < 7; round++) {
                    const start = performance.now();
                    for (let j = 0; j < 1000; j++)
                        c.getFirstLinkpathDest(query.link, query.source);
                    times.push(performance.now() - start);
                }
                return { category: query.category, result: path, warmupOperations: 1000, batchSize: 1000, samplesMs: times };
            }), manifest.queries) }));
        const preparationStarted = performance.now();
        const affectedRows = [];
        const deleted = deletionPath;
        for (let i = 0; i < manifest.options.notes; i++)
            if (i !== deletionIndex && (i < 10 || referencesFor(i, manifest.options).some(r => r.target === deleted)))
                affectedRows.push(expectedRow(i, true));
        affectedRows.push({ path: "Incremental-added.md", resolved: { [notePath(0)]: 1 }, missing: {} });
        const preparedWrites = [];
        for (let i = 0; i < 10; i++) {
            const file = join(vault, notePath(i));
            preparedWrites.push({ file, text: (await readFile(file, "utf8")) + "\n[[Incremental-added]]\n" });
        }
        report.incrementalPreparationMs = performance.now() - preparationStarted;
        await phase("incremental", async () => {
            await page.evaluate(first => { window.__stressFirstNote = first; }, notePath(0));
            const started = performance.now();
            for (const { file, text } of preparedWrites)
                await writeFile(file, text);
            await writeFile(join(vault, "Incremental-added.md"), `# Added\n[[${notePath(0)}]]\n`);
            await unlink(join(vault, deletionPath));
            await verifyRows(page, affectedRows);
            await page.waitForFunction(deleted => !window.app.metadataCache.resolvedLinks[deleted], deleted, { timeout: timeoutMs });
            const convergenceMs = performance.now() - started;
            const validation = await ready(page, true);
            delete validation.readyAt;
            return { modified: 10, added: 1, deleted: 1, deletionPath, convergenceMs, affectedRows: affectedRows.length, ...validation };
        });
        report.rendererLagMs = distribution(await page.evaluate(() => window.__stressLag));
        await sampleMemory();
        await close();
        // Run the full pinned revision's snapshot in a separate DOM-free Node
        // process (the controller starts this script with Node, not Electron).
        await phase("nodeSnapshot", async () => {
            assert.equal(globalThis.window, undefined);
            assert.equal(process.versions.electron, undefined);
            const { createWikiSnapshot } = createRequire(import.meta.url)(snapshotBundle);
            const entries = [];
            const captureStart = performance.now();
            // Use immutable source fixture; desktop incremental mutations are separate.
            for (let i = 0; i < manifest.options.notes; i++)
                entries.push({ path: notePath(i), kind: "note", text: await readFile(join(config.sourceVault, notePath(i)), "utf8") });
            entries.push({ path: attachmentPath, kind: "attachment" });
            const captureMs = performance.now() - captureStart;
            const limits = { maxEntries: entries.length, maxVisitedEntries: entries.length * 8, maxDepth: 32, maxNoteBytes: 2 * 1024 * 1024, maxTotalNoteBytes: manifest.stats.bytes };
            const start = performance.now();
            const snapshot = createWikiSnapshot(entries, { discoveryComplete: true, limits });
            const constructionMs = performance.now() - start;
            assert.equal(snapshot.listFiles().length, entries.length);
            const categories = manifest.queries.map(query => {
                const result = snapshot.resolve(query.source, query.link);
                assert.equal(result.status, query.strict, query.category);
                const expected = query.strictCandidates ?? query.candidates;
                if (result.status === "resolved")
                    assert.ok(expected.includes(result.path), `${query.category}: unexpected target ${result.path}`);
                if (result.status === "ambiguous")
                    assert.deepEqual([...result.candidates].sort(), [...expected].sort(), query.category);
                if (["heading", "block", "self", "explicit-relative"].includes(query.category) && query.link.includes("#"))
                    assert.equal(result.subpath.status, "found", query.category);
                for (let j = 0; j < 1000; j++)
                    snapshot.resolve(query.source, query.link);
                const samples = [];
                for (let round = 0; round < 7; round++) {
                    const start = performance.now();
                    for (let j = 0; j < 1000; j++)
                        snapshot.resolve(query.source, query.link);
                    samples.push(performance.now() - start);
                }
                return { category: query.category, status: result.status, warmupOperations: 1000, batchSize: 1000, samplesMs: samples };
            });
            return { captureMs, constructionMs, suppliedEntries: entries.length, limits, categories, nodeMemory: process.memoryUsage(), nodeExecArgv: process.execArgv, info: snapshot.info, coverage: snapshot.outgoing(notePath(0)).coverage };
        });
        if (report.errors.some(error => error.startsWith("pageerror:")))
            throw Error("Renderer page errors invalidate sample");
        if (resourceError)
            throw Error(resourceError);
        report.status = "ok";
    }
    catch (error) {
        report.status = resourceError ? "resource-limit" : "failed";
        report.error = resourceError ?? String(error);
    }
    finally {
        try {
            await close();
        }
        catch (error) {
            report.errors.push(`close: ${String(error)}`);
            report.status = "failed";
        }
        if (resourceError) {
            report.status = "resource-limit";
            report.error = resourceError;
            if (report.phases[report.activePhase])
                report.phases[report.activePhase].status = "invalid";
        }
        if (report.errors.some(error => error.startsWith("pageerror:"))) {
            report.status = "failed";
            for (const phase of Object.values(report.phases))
                if (phase.status === "ok")
                    phase.status = "invalid";
        }
        const byPhase = {};
        for (const phase of new Set(report.memorySamples.map(s => s.phase))) {
            const samples = report.memorySamples.filter(s => s.phase === phase), byType = {};
            for (const type of new Set(samples.flatMap(s => s.processes.map(p => p.type)))) {
                const totals = samples.map(s => s.processes.filter(p => p.type === type).reduce((n, p) => n + p.workingSetMiB, 0));
                byType[type] = { peakMiB: Math.max(...totals), settledMiB: totals.at(-1) };
            }
            byPhase[phase] = { peakMiB: Math.max(...samples.map(s => s.totalWorkingSetMiB)), settledMiB: samples.at(-1).totalWorkingSetMiB, byType };
        }
        report.memory = { metric: "sum of process working sets, not unique memory", sampleIntervalMs: 250, byPhase, peakMiB: Math.max(0, ...report.memorySamples.map(s => s.totalWorkingSetMiB)), settled: report.memorySamples.at(-1) ?? null };
        await save();
    }
    return report;
}
if (process.argv[2] === "--config") {
    const report = await runSample(JSON.parse(await readFile(process.argv[3], "utf8")));
    process.exitCode = report.status === "ok" ? 0 : 1;
}

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadata } from "../../src/wiki/metadata";
import { createWikiSnapshot } from "../../src/wiki/snapshot";
import { resolveFirstLinkpathDest } from "../../src/wiki/link-resolution";
import { execFileSync } from "node:child_process";
import { generateSyntheticVault, syntheticNote, optionsFor, notePath, queryCases, verifySyntheticVault, incrementalDeletionIndex, incrementalGraphFor } from "../../scripts/synthetic-vault.mts";
const roots: string[] = [];
async function root() { const p = await realpath(await mkdtemp(join(tmpdir(), "stress-generator-test-"))); roots.push(p); return p; }
afterEach(async () => { for (const p of roots.splice(0))
    await rm(p, { recursive: true, force: true }); });
describe("synthetic vault generator", () => {
    it("selects an unmodified globally unique deletion basename for arbitrary sizes", () => {
        for (const [notes, expected] of [[20,17],[128,121],[100000,99993]]) {
            const index=incrementalDeletionIndex(optionsFor({notes}));
            expect(index).toBe(expected);
            expect(index).toBeGreaterThanOrEqual(10);
            expect(index).toBeLessThan(notes);
            expect(notePath(index).split("/").at(-1)).toBe(`Unique-${index}.md`);
        }
    });
    it("demonstrates why deleting a colliding basename is not a missing-link oracle", () => {
        const first={path:notePath(63)},last={path:notePath(127)};
        const files=new Map([[first.path,first],[last.path,last]]);
        const provider={getFileByPath:(p:string)=>files.get(p)??null,byBasename:new Map([["twin-63",[first.path,last.path]]]),byAlias:new Map<string,string[]>()};
        expect(resolveFirstLinkpathDest("Twin-63",notePath(111),provider)?.path).toBe(last.path);
        files.delete(last.path);provider.byBasename.set("twin-63",[first.path]);
        expect(resolveFirstLinkpathDest("Twin-63",notePath(111),provider)?.path).toBe(first.path);
    });
    it.each([20,128])("matches the actual desktop incremental graph after unique deletion at size %i", notes => {
        const options=optionsFor({notes});
        const deleted=incrementalDeletionIndex(options);
        const surviving=Array.from({length:notes},(_,i)=>i).filter(i=>i!==deleted).map(i=>({...syntheticNote(i,options),index:i}));
        const files=new Map([...surviving.map(n=>({path:n.path})),{path:"Attachments/pixel.png"},{path:"Incremental-added.md"}].map(f=>[f.path,f]));
        const byBasename=new Map<string,string[]>(),byAlias=new Map<string,string[]>();
        for(const n of surviving) {
            const basename=n.path.split("/").at(-1)!.slice(0,-3).toLowerCase();
            byBasename.set(basename,[...(byBasename.get(basename)??[]),n.path]);
            for(const alias of parseMetadata(n.content).aliases)byAlias.set(alias.toLowerCase(),[...(byAlias.get(alias.toLowerCase())??[]),n.path]);
        }
        const provider={getFileByPath:(p:string)=>files.get(p)??null,byBasename,byAlias};
        for(const n of surviving) {
            const parsed=parseMetadata(n.content+(n.index<10?"\n[[Incremental-added]]\n":""));
            const resolved:Record<string,number>={},missing:Record<string,number>={};
            for(const link of [...parsed.links,...parsed.embeds]) {
                const destination=resolveFirstLinkpathDest(link.link,n.path,provider);
                const record=destination?resolved:missing,key=destination?.path??link.link.split("#")[0];
                record[key]=(record[key]??0)+1;
            }
            expect({path:n.path,resolved,missing}).toEqual(incrementalGraphFor(n.index,options));
        }
    });
    it("independently resolves all generated mixed references with both real policies", () => {
        const options = optionsFor({ notes: 128 });
        const notes = Array.from({ length: 128 }, (_, i) => syntheticNote(i, options));
        const entries = notes.map(n => ({ path: n.path, kind: "note" as const, text: n.content }));
        const files = new Map([...entries, { path: "Attachments/pixel.png", kind: "attachment" as const }].map(f => [f.path, f]));
        const byBasename = new Map<string, string[]>(), byAlias = new Map<string, string[]>();
        for (const n of notes) {
            const basename = n.path.split("/").at(-1)!.slice(0, -3).toLowerCase();
            byBasename.set(basename, [...(byBasename.get(basename) ?? []), n.path]);
            for (const a of parseMetadata(n.content).aliases)
                byAlias.set(a.toLowerCase(), [...(byAlias.get(a.toLowerCase()) ?? []), n.path]);
        }
        const provider = { getFileByPath: (p: string) => files.get(p) ?? null, byBasename, byAlias };
        const snapshot = createWikiSnapshot([...files.values()]);
        for (const n of notes) {
            const parsed = parseMetadata(n.content);
            const actual = [...parsed.links, ...parsed.embeds];
            expect(actual.length).toBe(n.references.length);
            for (const r of n.references) {
                expect(actual.some(a => a.link === r.link)).toBe(true);
                expect(resolveFirstLinkpathDest(r.link, n.path, provider)?.path ?? null).toBe(r.target);
                const resolution = snapshot.resolve(n.path, r.link);
                expect(resolution.status).toBe(r.target ? "resolved" : "missing");
                if (r.target)
                    expect(resolution.path).toBe(r.target);
                if (r.target && r.link.includes("#"))
                    expect(resolution.subpath.status).toBe("found");
            }
        }
        for (const query of queryCases(options))
            expect(snapshot.resolve(query.source, query.link).status).toBe(query.strict);
    });
    it("runs the actual CLI and rejects unknown flags", async () => {
        const p = await root();
        const output = execFileSync(process.execPath, ["scripts/generate-synthetic-vault.mjs", `--output=${join(p, "cli")}`, "--notes=20"], { encoding: "utf8" });
        expect(JSON.parse(output).stats.notes).toBe(20);
        expect(() => execFileSync(process.execPath, ["scripts/generate-synthetic-vault.mjs", "--bogus=x"], { stdio: "pipe" })).toThrow();
    });
    it("verifies digest and rejects extra files before fixture reuse", async () => {
        const p = join(await root(), "fixture");
        const manifest = await generateSyntheticVault(p, { notes: 20 });
        expect(await verifySyntheticVault(p)).toEqual(manifest);
        await writeFile(join(p, "unexpected.md"), "extra");
        await expect(verifySyntheticVault(p)).rejects.toThrow("Unexpected fixture entry");
        await rm(join(p, "unexpected.md"));
        await writeFile(join(p, notePath(0)), "modified");
        await expect(verifySyntheticVault(p)).rejects.toThrow("digest/size mismatch");
    });
    it("does not reuse fixture symlinks or unfinished generation", async () => {
        const p = join(await root(), "fixture");
        await generateSyntheticVault(p, { notes: 20 });
        await symlink(join(p, notePath(0)), join(p, "external"));
        await expect(verifySyntheticVault(p)).rejects.toThrow("symlink");
        await rm(join(p, "external"));
        await writeFile(join(p, "GENERATION-INCOMPLETE.txt"), "interrupted");
        await expect(verifySyntheticVault(p)).rejects.toThrow("Unexpected fixture entry");
    });
    it("rejects plugin configuration, tampered query plans and unbounded manifest options", async () => {
        const p = join(await root(), "fixture");
        const manifest = await generateSyntheticVault(p, { notes: 20 });
        await writeFile(join(p, ".geode"), "unexpected config");
        await expect(verifySyntheticVault(p)).rejects.toThrow("Unexpected fixture entry");
        await rm(join(p, ".geode"));
        await writeFile(join(p, "synthetic-manifest.json"), JSON.stringify({ ...manifest, queries: [] }));
        await expect(verifySyntheticVault(p)).rejects.toThrow("query cases altered");
        await writeFile(join(p, "synthetic-manifest.json"), JSON.stringify({ ...manifest, options: { ...manifest.options, notes: 1e15 } }));
        await expect(verifySyntheticVault(p)).rejects.toThrow("notes must");
    });
    it("has deterministic bytes and parser-verified declared references", () => {
        const options = optionsFor({ notes: 200, seed: 1, profile: "dense" });
        const note = syntheticNote(100, options);
        expect(note).toEqual(syntheticNote(100, options));
        expect(note.content).not.toBe(syntheticNote(100, { ...options, seed: 2 }).content);
        const metadata = parseMetadata(note.content);
        expect(metadata.links.length + metadata.embeds.length).toBe(96);
        expect(metadata.aliases).toContain("Shared alias 3");
        expect(metadata.headings.length).toBeGreaterThan(0);
        expect(metadata.listItems?.some(item => item.id === "anchor")).toBe(true);
        expect(Buffer.byteLength(note.content)).toBeGreaterThanOrEqual(128 * 1024);
        expect(notePath(0)).not.toBe(notePath(64));
        expect(notePath(0).split("/").at(-1)).toBe(notePath(64).split("/").at(-1));
    });
    it("writes repeatable manifests and leaves existing outputs untouched", async () => {
        const p = await root();
        const a = await generateSyntheticVault(join(p, "a"), { notes: 20 });
        const b = await generateSyntheticVault(join(p, "b"), { notes: 20 });
        expect(a).toEqual(b);
        expect(a.stats.notes).toBe(20);
        expect(a.stats.wikiReferences).toBe(20 * 24);
        expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
        await expect(generateSyntheticVault(join(p, "a"), { notes: 20 })).rejects.toThrow();
        expect(JSON.parse(await readFile(join(p, "a", "synthetic-manifest.json"), "utf8"))).toEqual(a);
    });
    it("rejects invalid options before creating output", async () => {
        const p = await root();
        for (const notes of [0, -1, 1.5, NaN, 100001])
            await expect(generateSyntheticVault(join(p, "bad"), { notes })).rejects.toThrow();
        expect(await readdir(p)).toEqual([]);
        expect(() => optionsFor({ profile: "bogus" as never })).toThrow();
        expect(() => optionsFor({ seed: -1 })).toThrow();
    });
    it("refuses symlink outputs and symlink ancestors without touching targets", async () => {
        const p = await root();
        await symlink(p, join(p, "alias"));
        await expect(generateSyntheticVault(join(p, "alias"), { notes: 20 })).rejects.toThrow();
        await expect(generateSyntheticVault(join(p, "alias", "nested"), { notes: 20 })).rejects.toThrow(/symlink/i);
        expect(await readdir(p)).toEqual(["alias"]);
    });
    it("retains partial outputs and an explicit failure marker on I/O failure", async () => {
        const p = await root();
        let writes = 0;
        await expect(generateSyntheticVault(join(p, "partial"), { notes: 20 }, async (file, bytes) => {
            if (++writes === 3)
                throw new Error("synthetic disk fault");
            await writeFile(file, bytes, { flag: "wx" });
        })).rejects.toThrow("synthetic disk fault");
        expect(await readFile(join(p, "partial", "GENERATION-FAILED.txt"), "utf8")).toContain("synthetic disk fault");
        expect(await readdir(join(p, "partial"))).not.toContain("synthetic-manifest.json");
    });
});

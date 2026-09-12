import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
export type Profile = "linked" | "dense";
export interface Options {
    notes: number;
    seed: number;
    profile: Profile;
}
export function optionsFor(input: Partial<Options> = {}): Options {
    const value = { notes: 10000, seed: 1, profile: "linked" as Profile, ...input };
    if (!Number.isSafeInteger(value.notes) || value.notes < 20 || value.notes > 100000)
        throw Error("notes must be an integer from 20 to 100000");
    if (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff)
        throw Error("seed must be a uint32");
    if (!["linked", "dense"].includes(value.profile))
        throw Error("profile must be linked or dense");
    return value;
}
export function notePath(i: number): string {
    const name = i % 8 === 1 ? `Unique-${i}` : `Twin-${i % 64}`;
    return `Area-${String(i % 16).padStart(2, "0")}/Café 空間/Batch-${Math.floor(i / 64)}/Depth-${i % 4}/${name}.md`;
}
export function incrementalDeletionIndex(options: Options): number {
    // Avoid basename fallback after deletion: every index 1 mod 8 has a
    // globally unique basename. The final such index is outside modifications
    // 0..9 even at the minimum supported fixture size (20 -> 17).
    return 1 + Math.floor((options.notes - 2) / 8) * 8;
}
export const attachmentPath = "Attachments/pixel.png";
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
export interface Reference {
    link: string;
    target: string | null;
    embed: boolean;
}
export function referencesFor(i: number, options: Options): Reference[] {
    const count = options.profile === "dense" ? 96 : 24;
    return Array.from({ length: count }, (_, slot) => {
        const targetIndex = slot === 0 ? (i + 1) % options.notes : slot % 6 === 0 ? 0 : ((Math.imul(i + 1, 1664525) >>> 0) + slot * 97 + options.seed) % options.notes;
        const target = notePath(targetIndex);
        if (slot === count - 1)
            return { link: `Missing-${i % 32}`, target: null, embed: false };
        if (slot === count - 2)
            return { link: attachmentPath, target: attachmentPath, embed: true };
        if (slot === count - 3)
            return { link: "#Section", target: notePath(i), embed: false };
        if (slot === count - 4)
            return { link: target + "#Leaf", target, embed: true };
        if (slot > 0 && slot % 7 === 4)
            return { link: `Alias ${targetIndex}`, target, embed: false };
        if (slot > 0 && slot % 7 === 5) {
            const sibling = Math.floor(i / 64) * 64 + (i % 64 + 16) % 64;
            const relativeTarget = notePath(sibling < options.notes ? sibling : i);
            return { link: relativeTarget.split("/").at(-1)!.slice(0, -3), target: relativeTarget, embed: false };
        }
        if (slot > 0 && slot % 7 === 6) {
            const uniqueIndex = 1 + (targetIndex % Math.ceil((options.notes - 1) / 8)) * 8;
            return { link: `Unique-${uniqueIndex}`, target: notePath(uniqueIndex), embed: false };
        }
        return { link: target.slice(0, -3) + (slot % 7 === 2 ? "#Section" : slot % 7 === 3 ? "#^anchor" : ""), target, embed: false };
    });
}
export function syntheticNote(i: number, options: Options): {
    path: string;
    content: string;
    references: Reference[];
} {
    if (!Number.isInteger(i) || i < 0 || i >= options.notes)
        throw Error("invalid note index");
    const references = referencesFor(i, options);
    let content = `---\naliases: ["Alias ${i}", "Shared alias ${Math.floor(i / 32)}"]\ntags: [synthetic, area-${i % 16}]\nfixture: {index: ${i}, seed: ${options.seed}, active: true}\n---\n# Synthetic note ${i}\n\n## Section\n- Fixture marker ${i}. ^anchor\n\n`;
    content += references.map((r, slot) => `${r.embed ? "!" : ""}[[${r.link}|${slot === 0 ? "Next synthetic note" : `Reference ${slot}`}]]`).join("\n");
    content += `\n\n[Markdown example](${encodeURI(notePath((i + 1) % options.notes))})\n\n#synthetic/tag\n`;
    content += `\n## Leaf\nShallow synthetic transclusion ${i}, with no links.\n\n## Filler\n`;
    // Reference-bearing content comes before filler and below the metadata scan cap.
    const minimum = i % 100 === 0 ? 128 * 1024 : 1024 + (i % 8) * 256;
    content += "\nSynthetic filler only. ".repeat(Math.max(0, Math.ceil((minimum - Buffer.byteLength(content)) / 24)));
    while (Buffer.byteLength(content) < minimum)
        content += " ";
    return { path: notePath(i), content, references };
}
export function graphFor(i: number, options: Options) {
    const resolved: Record<string, number> = {};
    const missing: Record<string, number> = {};
    for (const r of referencesFor(i, options)) {
        const record = r.target === null ? missing : resolved;
        const key = r.target ?? r.link;
        record[key] = (record[key] ?? 0) + 1;
    }
    return { path: notePath(i), resolved, missing };
}
export function incrementalGraphFor(i: number, options: Options) {
    const row=graphFor(i,options);
    const deleted=notePath(incrementalDeletionIndex(options));
    delete row.resolved[deleted];
    for(const reference of referencesFor(i,options)) {
        if(reference.target!==deleted) continue;
        const key=reference.link.split("#")[0];
        row.missing[key]=(row.missing[key]??0)+1;
    }
    if(i<10) row.resolved["Incremental-added.md"]=1;
    return row;
}
export function queryCases(options: Options) {
    const source = notePath(0);
    const exact = notePath(1);
    const collisionCandidates = Array.from({ length: options.notes }, (_, i) => i).filter(i => i % 64 === 0).map(notePath);
    return [
        { category: "self", source, link: "#Section", candidates: [source], strict: "resolved" },
        { category: "exact", source, link: exact, candidates: [exact], strict: "resolved" },
        { category: "relative", source, link: "Twin-16", candidates: [notePath(16)], strict: "resolved" },
        { category: "explicit-relative", source, link: "./Twin-0", candidates: [], strictCandidates: [source], strict: "resolved" },
        { category: "basename-unique", source, link: "Unique-1", candidates: [exact], strict: "resolved" },
        { category: "basename-collision", source: exact, link: "Twin-0", candidates: collisionCandidates, strict: collisionCandidates.length > 1 ? "ambiguous" : "resolved" },
        { category: "alias-unique", source, link: "Alias 1", candidates: [exact], strict: "resolved" },
        { category: "alias-shared", source, link: "Shared alias 0", candidates: Array.from({ length: Math.min(32, options.notes) }, (_, i) => notePath(i)), strict: "ambiguous" },
        { category: "missing", source, link: "Missing-0", candidates: [], strict: "missing" },
        { category: "heading", source, link: exact + "#Section", candidates: [exact], strict: "resolved" },
        { category: "block", source, link: exact + "#^anchor", candidates: [exact], strict: "resolved" },
    ];
}
/** Refuse existing destinations and every symlink ancestor. Never remove user paths. */
export async function freshDirectory(output: string): Promise<string> {
    if (!isAbsolute(output))
        throw Error("output must be an explicit absolute path");
    const root = resolve(output);
    const ancestors: string[] = [];
    for (let p = dirname(root);; p = dirname(p)) {
        ancestors.push(p);
        if (p === parse(p).root)
            break;
    }
    for (const p of ancestors.reverse()) {
        const stat = await lstat(p);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw Error(`symlink or non-directory ancestor: ${p}`);
    }
    await mkdir(root); // Atomic exclusive claim; existing file/directory/symlink all fail.
    return root;
}
export async function generateSyntheticVault(output: string, input: Partial<Options> = {}, write: (path: string, bytes: string | Buffer) => Promise<unknown> = (p, b) => writeFile(p, b, { flag: "wx" })) {
    const options = optionsFor(input);
    const root = await freshDirectory(output);
    await writeFile(join(root, "GENERATION-INCOMPLETE.txt"), "Generation has not completed. Do not benchmark this directory.\n", { flag: "wx" });
    const digest = createHash("sha256");
    const stats = { notes: 0, attachments: 0, bytes: 0, wikiReferences: 0, markdownLinks: 0, missingReferences: 0, longNotes: 0 };
    const basenames: Record<string, number> = {};
    const addDigest = (p: string, bytes: Buffer) => { digest.update(p + "\0"); digest.update(bytes); digest.update("\0"); stats.bytes += bytes.length; };
    try {
        // Sequential writes deliberately bound memory and open files even at 100k.
        for (let i = 0; i < options.notes; i++) {
            const note = syntheticNote(i, options);
            await mkdir(dirname(join(root, note.path)), { recursive: true });
            const bytes = Buffer.from(note.content);
            await write(join(root, note.path), bytes);
            addDigest(note.path, bytes);
            stats.notes++;
            stats.wikiReferences += note.references.length;
            stats.markdownLinks++;
            stats.missingReferences++;
            if (bytes.length >= 128 * 1024)
                stats.longNotes++;
            const name = note.path.split("/").at(-1)!;
            basenames[name] = (basenames[name] ?? 0) + 1;
        }
        await mkdir(join(root, "Attachments"));
        await write(join(root, attachmentPath), pixel);
        addDigest(attachmentPath, pixel);
        stats.attachments++;
        const manifest = {
            schemaVersion: 1, generator: "geode-synthetic-vault-v1", options, stats, digest: digest.digest("hex"),
            digestOrder: "note index order then attachment; UTF8 path NUL bytes NUL; excludes manifest",
            collisions: { basenameBuckets: Object.values(basenames).filter(n => n > 1).sort((a, b) => a - b), sharedAliasBucketMaximum: Math.min(32, options.notes) },
            queries: queryCases(options),
            navigation: Array.from({ length: 100 }, (_, step) => { const i = (options.seed + step) % options.notes; return { source: notePath(i), target: notePath((i + 1) % options.notes), marker: `Synthetic note ${(i + 1) % options.notes}` }; }),
            coverage: { markdownLinks: "present but not included in current wiki-only graph", missing: "one deliberate missing wiki target per note", ambiguities: "query cases only; generated graph uses exact targets", longNotes: "every 100th note at least 128KiB" },
        };
        await write(join(root, "synthetic-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
        await unlink(join(root, "GENERATION-INCOMPLETE.txt"));
        return manifest;
    }
    catch (error) {
        await writeFile(join(root, "GENERATION-FAILED.txt"), `Incomplete; preserve for diagnosis.\n${String(error)}\n`, { flag: "wx" });
        throw error;
    }
}
/** Validate the complete unmodified generated inventory before any app launch. */
export async function verifySyntheticVault(root: string) {
    if (!isAbsolute(root))
        throw Error("fixture must be absolute");
    for (let p = resolve(root);; p = dirname(p)) {
        const st = await lstat(p);
        if (st.isSymbolicLink() || !st.isDirectory())
            throw Error("fixture symlink/non-directory");
        if (p === parse(p).root)
            break;
    }
    const manifestStat = await lstat(join(root, "synthetic-manifest.json"));
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 10 * 1024 * 1024)
        throw Error("Invalid manifest file");
    const manifest = JSON.parse(await readFile(join(root, "synthetic-manifest.json"), "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.generator !== "geode-synthetic-vault-v1")
        throw Error("Unsupported generator manifest");
    const options = optionsFor(manifest.options);
    const expected = new Set([...Array.from({ length: options.notes }, (_, i) => notePath(i)), attachmentPath, "synthetic-manifest.json"]);
    const directories = new Set<string>();
    for (const file of expected) {
        let p = file;
        while (p.includes("/")) {
            p = p.slice(0, p.lastIndexOf("/"));
            directories.add(p);
        }
    }
    let bytes = 0;
    async function walk(relative: string) {
        for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
            const p = relative ? relative + "/" + entry.name : entry.name;
            if (entry.isSymbolicLink())
                throw Error(`Unexpected fixture symlink: ${p}`);
            if (entry.isDirectory()) {
                if (!directories.has(p))
                    throw Error(`Unexpected fixture directory: ${p}`);
                await walk(p);
            }
            else if (!entry.isFile() || !expected.delete(p))
                throw Error(`Unexpected fixture entry: ${p}`);
        }
    }
    await walk("");
    if (expected.size)
        throw Error("Missing fixture entries");
    const digest = createHash("sha256");
    for (const p of [...Array.from({ length: options.notes }, (_, i) => notePath(i)), attachmentPath]) {
        const content = await readFile(join(root, p));
        bytes += content.length;
        digest.update(p + "\0");
        digest.update(content);
        digest.update("\0");
    }
    if (digest.digest("hex") !== manifest.digest || bytes !== manifest.stats.bytes)
        throw Error("Fixture digest/size mismatch");
    // Never trust executable query plans in a supplied manifest: reconstruct the
    // expected manifest cases from validated version/config and compare them.
    if (JSON.stringify(manifest.queries) !== JSON.stringify(queryCases(options)))
        throw Error("Fixture query cases altered");
    const navigation = Array.from({ length: 100 }, (_, step) => { const i = (options.seed + step) % options.notes; return { source: notePath(i), target: notePath((i + 1) % options.notes), marker: `Synthetic note ${(i + 1) % options.notes}` }; });
    if (JSON.stringify(manifest.navigation) !== JSON.stringify(navigation))
        throw Error("Fixture navigation cases altered");
    return manifest;
}

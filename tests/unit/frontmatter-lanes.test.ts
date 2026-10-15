import { expect, it, vi } from "vitest";
import { patchFrontmatter } from "../../src/renderer/frontmatter-io";
import { FileManager } from "../../src/renderer/file-manager";
import { BaseView } from "../../src/renderer/views/base-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
import type { TFile } from "../../src/renderer/types";
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => resolve = done);
    return { promise, resolve };
}
const tick = () => new Promise<void>(done => setImmediate(done));
function file(path: string): TFile {
    return {
        kind: "file", path, name: path, basename: path, extension: path.endsWith(".md") ? "md" : "base", parent: "", ctime: 0, mtime: 0, size: 0
    };
}
function fixture() {
    const source = file("Source.md"), owner = file("Tasks.base"), files = new Map([[source.path, source], [owner.path, owner]]), contents = new Map([[source.path, "---\r\npriority: 2\r\nscore: 3\r\n---\r\nOriginal source\r\n\0tail"]]);
    const vault = { getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null), read: vi.fn(async (f: TFile) => contents.get(f.path)!), modify: vi.fn(async (f: TFile, text: string, _options?: unknown) => {
            contents.set(f.path, text);
        }) };
    const app = { vault, notify: vi.fn() };
    return {
        source, owner, files, contents, vault, app
    };
}
function base(f: ReturnType<typeof fixture>, owner = f.owner) {
    const view = Object.create(BaseView.prototype) as any;
    Object.assign(view, {
        file: owner, renderOwner: new RenderOwnership().create(view), rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, sourceEdit: null, vaultSwitching: false, sourceConflictReadOnly: false, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), tableView: { editIdentity: null }, setSaveStatus: vi.fn(), runAndRender: vi.fn(), app: f.app
    });
    return view;
}
it.each(["same Base", "different Bases", "Base and FileManager"])("serializes %s through completion of the first write before the second read", async (mode) => {
    const f = fixture(), firstView = base(f), secondOwner = file("Other.base");
    f.files.set(secondOwner.path, secondOwner);
    const secondView = mode === "same Base" ? firstView : base(f, secondOwner), gate = deferred(), write = f.vault.modify.getMockImplementation()!;
    f.vault.modify.mockImplementationOnce(async (...args) => {
        await gate.promise;
        await write(...args);
    });
    const first = firstView.editCell(f.source, "note.priority", "9");
    await tick();
    expect(f.vault.modify).toHaveBeenCalledOnce();
    const second = mode === "Base and FileManager" ? new FileManager(f.app as any).processFrontMatter(f.source, fm => {
        fm.score = 11;
    }) : secondView.editCell(f.source, "note.score", "11");
    await tick();
    expect(f.vault.read).toHaveBeenCalledOnce();
    gate.resolve();
    await Promise.all([first, second]);
    expect(f.contents.get(f.source.path)).toBe("---\r\npriority: 9\r\nscore: 11\r\n---\r\nOriginal source\r\n\0tail");
    expect(f.vault.modify).toHaveBeenCalledTimes(2);
});
it("shares direct helper and two FileManager callers without nested queues", async () => {
    const f = fixture(), gate = deferred(), write = f.vault.modify.getMockImplementation()!;
    f.vault.modify.mockImplementationOnce(async (...args) => {
        await gate.promise;
        await write(...args);
    });
    const seen: number[] = [];
    const first = patchFrontmatter(f.vault, f.source, fm => {
        fm.priority = 9;
    });
    await tick();
    const second = new FileManager(f.app as any).processFrontMatter(f.source, fm => {
        seen.push(fm.priority);
        fm.score = 11;
    });
    const third = new FileManager(f.app as any).processFrontMatter(f.source, fm => {
        seen.push(fm.score);
        fm.last = true;
    });
    await tick();
    expect(f.vault.read).toHaveBeenCalledOnce();
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(seen).toEqual([9, 11]);
    expect(f.contents.get(f.source.path)).toContain("last: true");
});
it.each(["read", "guard", "callback", "write"])("returns the original %s rejection and admits the next operation", async (phase) => {
    const f = fixture(), error = new Error(`${phase} failed`), guard = vi.fn(() => {
        if (phase === "guard")
            throw error;
    }), mutate = vi.fn((fm: Record<string, unknown>) => {
        if (phase === "callback")
            throw error;
        fm.first = true;
    });
    if (phase === "read")
        f.vault.read.mockRejectedValueOnce(error);
    if (phase === "write")
        f.vault.modify.mockRejectedValueOnce(error);
    const first = patchFrontmatter(f.vault, f.source, mutate, undefined, guard), failed = expect(first).rejects.toBe(error), second = patchFrontmatter(f.vault, f.source, fm => {
        fm.recovered = true;
    });
    await failed;
    await second;
    expect(f.contents.get(f.source.path)).toContain("recovered: true");
    expect(mutate).toHaveBeenCalledTimes(phase === "guard" || phase === "read" ? 0 : 1);
});
it.each(["thenable", "serialization"])("does not replay a %s callback and does not poison its lane", async (phase) => {
    const f = fixture(), mutate = vi.fn((fm: Record<string, unknown>) => {
        if (phase === "thenable")
            return Promise.reject(Error("late"));
        fm.bad = Symbol("unsupported");
    });
    const first = patchFrontmatter(f.vault, f.source, mutate), failed = expect(first).rejects.toThrow();
    const second = patchFrontmatter(f.vault, f.source, fm => {
        fm.good = true;
    });
    await failed;
    await second;
    expect(mutate).toHaveBeenCalledOnce();
    expect(f.vault.modify).toHaveBeenCalledOnce();
});
it("keeps successor lanes registered when older tails settle, including callback reentrancy", async () => {
    const f = fixture(), gate = deferred(), read = f.vault.read.getMockImplementation()!;
    let nested: Promise<void> | undefined;
    f.vault.read.mockImplementationOnce(read).mockImplementationOnce(async (target) => {
        await gate.promise;
        return read(target);
    });
    const first = patchFrontmatter(f.vault, f.source, fm => {
        fm.priority = 9;
        nested = patchFrontmatter(f.vault, f.source, next => {
            next.score = 11;
        });
    });
    await first;
    await tick();
    const third = patchFrontmatter(f.vault, f.source, fm => {
        fm.third = true;
    });
    await tick();
    expect(f.vault.read).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all([nested, third]);
    expect(f.contents.get(f.source.path)).toContain("priority: 9");
    expect(f.contents.get(f.source.path)).toContain("score: 11");
    expect(f.contents.get(f.source.path)).toContain("third: true");
});
it("does not block different captured paths or Vault objects and never folds case", async () => {
    const f = fixture(), other = fixture(), lower = file("source.md"), gate = deferred();
    f.files.set(lower.path, lower);
    f.contents.set(lower.path, "Lower\n");
    const read = f.vault.read.getMockImplementation()!;
    f.vault.read.mockImplementation(async (target) => {
        if (target === f.source)
            await gate.promise;
        return read(target);
    });
    const first = patchFrontmatter(f.vault, f.source, fm => {
        fm.blocked = true;
    });
    await tick();
    await Promise.all([patchFrontmatter(f.vault, lower, fm => {
            fm.independent = true;
        }), patchFrontmatter(other.vault, other.source, fm => {
            fm.independent = true;
        })]);
    expect(f.contents.get(lower.path)).toContain("independent: true");
    expect(other.contents.get(other.source.path)).toContain("independent: true");
    gate.resolve();
    await first;
});
it("preserves no-op behavior, admission order and exact write options", async () => {
    const f = fixture(), options = { mtime: 42 }, seen: number[] = [];
    await Promise.all([patchFrontmatter(f.vault, f.source, () => {
        }), patchFrontmatter(f.vault, f.source, fm => {
            seen.push(fm.priority as number);
            fm.priority = 9;
        }, options), patchFrontmatter(f.vault, f.source, fm => {
            seen.push(fm.priority as number);
            fm.priority = 11;
        })]);
    expect(seen).toEqual([2, 9]);
    expect(f.vault.modify).toHaveBeenCalledTimes(2);
    expect(f.vault.modify.mock.calls[0][2]).toBe(options);
    expect(f.contents.get(f.source.path)).toContain("priority: 11");
});
it.each(["queued", "read"])("rejects a changed helper path during %s before mutation", async (phase) => {
    const f = fixture(), gate = deferred(), read = f.vault.read.getMockImplementation()!;
    f.vault.read.mockImplementationOnce(async (target) => {
        await gate.promise;
        return read(target);
    });
    const first = patchFrontmatter(f.vault, f.source, fm => {
        fm.first = true;
    }), failed = expect(first).rejects.toThrow(/path/);
    await tick();
    const mutate = vi.fn();
    const second = phase === "queued" ? patchFrontmatter(f.vault, f.source, mutate) : undefined;
    const secondFailure = second ? expect(second).rejects.toThrow(/path/) : undefined;
    f.source.path = "Moved.md";
    gate.resolve();
    await failed;
    await secondFailure;
    expect(mutate).not.toHaveBeenCalled();
    expect(f.vault.modify).not.toHaveBeenCalled();
});
it("revalidates a FileManager callback that switches vaults before modify", async () => {
    const f = fixture(), other = fixture(), mutate = vi.fn((fm: Record<string, unknown>) => {
        fm.priority = 9;
        f.app.vault = other.vault;
    });
    await expect(new FileManager(f.app as any).processFrontMatter(f.source, mutate)).rejects.toThrow(/vault/);
    expect(mutate).toHaveBeenCalledOnce();
    expect(f.vault.modify).not.toHaveBeenCalled();
    expect(other.vault.modify).not.toHaveBeenCalled();
});
it("rejects a queued FileManager request after app.vault changes without touching the new vault", async () => {
    const f = fixture(), other = fixture(), gate = deferred(), write = f.vault.modify.getMockImplementation()!;
    f.vault.modify.mockImplementationOnce(async (...args) => {
        await gate.promise;
        await write(...args);
    });
    const first = patchFrontmatter(f.vault, f.source, fm => {
        fm.first = true;
    });
    await tick();
    const mutate = vi.fn(), second = new FileManager(f.app as any).processFrontMatter(f.source, mutate), failed = expect(second).rejects.toThrow(/vault/);
    await tick();
    f.app.vault = other.vault;
    gate.resolve();
    await first;
    await failed;
    expect(mutate).not.toHaveBeenCalled();
    expect(other.vault.read).not.toHaveBeenCalled();
    expect(other.vault.modify).not.toHaveBeenCalled();
});
it.each(["source replacement", "source deletion", "owner replacement", "owner deletion", "held", "conflict", "vault switch"])("rejects Base %s introduced while queued and retains its tracked failure", async (change) => {
    const f = fixture(), view = base(f), gate = deferred(), write = f.vault.modify.getMockImplementation()!;
    f.vault.modify.mockImplementationOnce(async (...args) => {
        await gate.promise;
        await write(...args);
    });
    const first = patchFrontmatter(f.vault, f.source, fm => {
        fm.first = true;
    });
    await tick();
    const second = view.editCell(f.source, "note.priority", "9"), failed = expect(second).rejects.toThrow();
    await tick();
    if (change === "source replacement")
        f.files.set(f.source.path, file(f.source.path));
    if (change === "source deletion")
        f.files.delete(f.source.path);

    if (change === "vault switch")
        f.app.vault = fixture().vault;
    if (change === "owner replacement")
        f.files.set(f.owner.path, file(f.owner.path));
    if (change === "owner deletion")
        f.files.delete(f.owner.path);
    if (change === "held")
        view.renderOwner.freezeAdmission();
    if (change === "conflict")
        view.sourceConflictReadOnly = true;
    gate.resolve();
    await first;
    await failed;
    expect(f.vault.modify).toHaveBeenCalledOnce();
    expect(view.renderOwner.hasUnacknowledgedWrites).toBe(true);
});
it.each(["source", "owner"])("rejects deletion/recreation of indexed Base %s during a delayed read", async (target) => {
    const f = fixture(), view = base(f), gate = deferred<string>();
    f.vault.read.mockImplementationOnce(() => gate.promise);
    const saving = view.editCell(f.source, "note.priority", "9"), failed = expect(saving).rejects.toThrow();
    await tick();
    const changed = target === "source" ? f.source : f.owner;
    f.files.set(changed.path, file(changed.path));
    gate.resolve(f.contents.get(f.source.path)!);
    await failed;
    expect(f.vault.modify).not.toHaveBeenCalled();
});

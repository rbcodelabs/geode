import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, settle } from "../helpers/fake-dom";
import {
  SyncConflictBannerController,
  SyncConflictBannerSlot,
  buildSyncConflictBanner,
  type SyncConflictBannerInfo,
  type SyncConflictBannerView,
} from "../../src/renderer/sync/conflict-banner";
import {
  SYNC_CONFLICT_BANNER_MESSAGE,
  SYNC_CONFLICT_CANCEL_LABEL,
  SYNC_CONFLICT_COMPARE_LABEL,
  SYNC_CONFLICT_DIALOG_SUBTITLE,
  SYNC_CONFLICT_DIALOG_TITLE,
  SYNC_CONFLICT_KEEP_LOCAL_LABEL,
  SYNC_CONFLICT_LOADING_TEXT,
  SYNC_CONFLICT_LOCAL_PANEL_TITLE,
  SYNC_CONFLICT_REMOTE_PANEL_TITLE,
  SYNC_CONFLICT_STALE_HEADS_MESSAGE,
  SYNC_CONFLICT_USE_REMOTE_LABEL,
  describeComparisonBlocker,
  describeComparisonBlockerForDialog,
  formatHeadLabels,
  planConflictRow,
} from "../../src/renderer/sync/conflict-presentation";
import { ConflictCompareModal, type ConflictCompareSyncApi } from "../../src/renderer/modals/conflict-compare-modal";
import type { HistoryComparisonBlocker, HistoryConflict, HistoryConflictComparison } from "../../src/renderer/sync/history-controller";
import type { App } from "../../src/renderer/app";

const root = path.resolve(__dirname, "../..");
const source = (relative: string) => fs.readFileSync(path.resolve(root, relative), "utf8");

let doc: FakeDocument;
beforeEach(() => {
  doc = new FakeDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const el = (tag = "div") => doc.createElement(tag) as unknown as HTMLElement;
const fake = (node: unknown) => node as unknown as FakeElement;
const find = (node: unknown, className: string) =>
  fake(node).tree().find((item) => item.classList.contains(className));
const all = (node: unknown, className: string) =>
  fake(node).tree().filter((item) => item.classList.contains(className));
const byText = (node: unknown, text: string) =>
  fake(node).tree().find((item) => item.textContent === text);

function conflict(over: Partial<HistoryConflict> = {}): HistoryConflict {
  return { entityId: "entity-1", namespace: "content", path: "Notes/a.md", heads: ["rec-a", "rec-b"], reason: "Concurrent edits", ...over };
}

/* ------------------------------------------------------------------ *
 * Banner                                                              *
 * ------------------------------------------------------------------ */

describe("sync conflict banner element", () => {
  it("uses the approved advisory copy and exactly one call to action", () => {
    const compare = vi.fn();
    const banner = fake(buildSyncConflictBanner(compare));
    expect(banner.classList.contains("sync-conflict-banner")).toBe(true);
    expect(find(banner, "sync-conflict-banner-message")!.textContent).toBe(SYNC_CONFLICT_BANNER_MESSAGE);
    const buttons = banner.tree().filter((item) => item.tagName === "button");
    expect(buttons.map((button) => button.textContent)).toEqual([SYNC_CONFLICT_COMPARE_LABEL]);
    buttons[0].click();
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it("announces itself advisorily rather than as an alert", () => {
    const banner = fake(buildSyncConflictBanner(() => {}));
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.getAttribute("aria-label")).toBe("Sync conflict");
  });
});

describe("sync conflict banner slot", () => {
  function view() {
    const container = el();
    const header = el();
    const body = el();
    fake(container).append(fake(header), fake(body));
    const slot = new SyncConflictBannerSlot(container, body);
    return { container, header, body, slot };
  }

  const info: SyncConflictBannerInfo = { entityId: "entity-1", path: "Notes/a.md", heads: ["rec-a", "rec-b"], reason: "Concurrent edits" };

  it("inserts below the view header and above the body", () => {
    const v = view();
    v.slot.present(info, () => {});
    expect(fake(v.container).children.map((child) => child.className)).toEqual(["", "sync-conflict-banner", ""]);
    expect(fake(v.container).children[0]).toBe(fake(v.header));
    expect(fake(v.container).children[2]).toBe(fake(v.body));
  });

  it("coexists with an external-edit recovery banner prepended above the header", () => {
    const v = view();
    const external = el();
    fake(external).className = "editor-conflict-banner";
    v.slot.present(info, () => {});
    fake(v.container).prepend(fake(external));
    expect(fake(v.container).children.map((child) => child.className)).toEqual([
      "editor-conflict-banner",
      "",
      "sync-conflict-banner",
      "",
    ]);
    // Clearing the sync banner must not disturb the recovery banner.
    v.slot.clear();
    expect(fake(v.container).children.map((child) => child.className)).toEqual(["editor-conflict-banner", "", ""]);
  });

  it("reuses the same element while the conflict identity is unchanged", () => {
    const v = view();
    v.slot.present(info, () => {});
    const first = v.slot.element;
    v.slot.present(info, () => {});
    expect(v.slot.element).toBe(first);
    v.slot.present({ ...info, heads: ["rec-a", "rec-c"] }, () => {});
    expect(v.slot.element).not.toBe(first);
    expect(all(v.container, "sync-conflict-banner")).toHaveLength(1);
  });

  it("removes the element on clear and is safe to clear twice", () => {
    const v = view();
    v.slot.present(info, () => {});
    v.slot.clear();
    v.slot.clear();
    expect(all(v.container, "sync-conflict-banner")).toHaveLength(0);
    expect(v.slot.element).toBeNull();
  });
});

describe("sync conflict banner controller", () => {
  function pane(filePath: string | null): SyncConflictBannerView & { presented: SyncConflictBannerInfo[]; cleared: number; compare: () => void } {
    const presented: SyncConflictBannerInfo[] = [];
    const state = {
      file: filePath === null ? null : { path: filePath },
      presented,
      cleared: 0,
      compare: () => {},
      presentSyncConflict(info: SyncConflictBannerInfo, onCompare: () => void) {
        presented.push(info);
        state.compare = onCompare;
      },
      clearSyncConflict() {
        state.cleared++;
      },
    };
    return state;
  }

  function setup(views: ReturnType<typeof pane>[], conflicts: HistoryConflict[]) {
    const compare = vi.fn();
    const list = { value: conflicts };
    const controller = new SyncConflictBannerController({
      views: () => views,
      conflicts: () => list.value,
      compare,
    });
    return { controller, compare, list };
  }

  it("shows the banner in every pane displaying the conflicted note and nowhere else", () => {
    const editing = pane("Notes/a.md");
    const reading = pane("Notes/a.md");
    const other = pane("Notes/b.md");
    const empty = pane(null);
    const h = setup([editing, reading, other, empty], [conflict()]);
    h.controller.refresh();
    expect(editing.presented).toHaveLength(1);
    expect(reading.presented).toHaveLength(1);
    expect(editing.presented[0]).toEqual({ entityId: "entity-1", path: "Notes/a.md", heads: ["rec-a", "rec-b"], reason: "Concurrent edits" });
    expect(other.presented).toHaveLength(0);
    expect(other.cleared).toBe(1);
    expect(empty.presented).toHaveLength(0);
    expect(empty.cleared).toBe(1);
  });

  it("ignores portable-config conflicts, which never map to an open note", () => {
    const view = pane("editor.json");
    const h = setup([view], [conflict({ namespace: "portable-config", path: "editor.json" })]);
    h.controller.refresh();
    expect(view.presented).toHaveLength(0);
    expect(view.cleared).toBe(1);
  });

  it("keeps the banner until the conflict actually leaves the sync state", () => {
    const view = pane("Notes/a.md");
    const h = setup([view], [conflict()]);
    h.controller.refresh();
    h.controller.refresh();
    expect(view.cleared).toBe(0);
    expect(view.presented).toHaveLength(2);
    h.list.value = [];
    h.controller.refresh();
    expect(view.cleared).toBe(1);
  });

  it("clears every pane on dispose, for vault switch and unload", () => {
    const first = pane("Notes/a.md");
    const second = pane("Notes/a.md");
    const h = setup([first, second], [conflict()]);
    h.controller.refresh();
    h.controller.dispose();
    expect(first.cleared).toBe(1);
    expect(second.cleared).toBe(1);
    h.controller.refresh();
    expect(first.presented).toHaveLength(1);
  });

  it("routes the banner action to the compare handler with the conflict identity", () => {
    const view = pane("Notes/a.md");
    const h = setup([view], [conflict()]);
    h.controller.refresh();
    view.compare();
    expect(h.compare).toHaveBeenCalledWith({ entityId: "entity-1", path: "Notes/a.md", heads: ["rec-a", "rec-b"], reason: "Concurrent edits" });
  });
});

/* ------------------------------------------------------------------ *
 * Presentation helpers                                                *
 * ------------------------------------------------------------------ */

describe("conflict version labels", () => {
  it("labels heads by opaque device id with no names, times or ordering claims", () => {
    const labels = formatHeadLabels([
      { recordId: "9c1d0000-0000-0000-0000-000000000000", deviceId: "a3f2b1c4-0000-0000-0000-000000000000" },
      { recordId: "7e440000-0000-0000-0000-000000000000", deviceId: "5d6e7f80-0000-0000-0000-000000000000" },
    ]);
    expect(labels).toEqual(["Device A3F2", "Device 5D6E"]);
    for (const label of labels) {
      expect(label).not.toMatch(/newest|latest|older|newer|ago|\d{4}-\d{2}-\d{2}|:\d\d/i);
    }
  });

  it("disambiguates two heads from the same device without implying an order", () => {
    const labels = formatHeadLabels([
      { recordId: "9c1d0000-0000-0000-0000-000000000000", deviceId: "a3f2b1c4-0000-0000-0000-000000000000" },
      { recordId: "7e440000-0000-0000-0000-000000000000", deviceId: "a3f2b1c4-0000-0000-0000-000000000000" },
    ]);
    expect(labels).toEqual(["Device A3F2 · version 9C1D", "Device A3F2 · version 7E44"]);
    expect(new Set(labels).size).toBe(2);
  });
});

describe("comparison blocker explanations", () => {
  const blockers: HistoryComparisonBlocker[] = [
    "portable-config", "folder", "deleted-version", "rename-or-move", "non-markdown", "missing-content", "oversize",
  ];

  it("explains why comparison is unavailable and what the remaining buttons do", () => {
    for (const blocker of blockers) {
      const text = describeComparisonBlocker(blocker);
      expect(text.length).toBeGreaterThan(20);
      expect(text).toContain("Keep local");
      expect(text).toContain("Accept version");
    }
    expect(new Set(blockers.map(describeComparisonBlocker)).size).toBe(blockers.length);
  });
});

describe("settings conflict row plan", () => {
  const comparison = (over: Partial<HistoryConflictComparison> = {}): HistoryConflictComparison => ({
    entityId: "entity-1", namespace: "content", path: "Notes/a.md", reason: "Concurrent edits",
    heads: [], local: { path: "Notes/a.md", present: true }, comparable: true, ...over,
  });

  it("offers a single compare action when the conflict is comparable", () => {
    const plan = planConflictRow(conflict(), comparison());
    expect(plan.mode).toBe("compare");
    expect(plan.fallback).toBeNull();
  });

  it("retains the existing buttons plus an explanation when comparison is blocked", () => {
    const plan = planConflictRow(conflict(), comparison({ comparable: false, notComparable: "oversize" }));
    expect(plan.mode).toBe("fallback");
    expect(plan.fallback).toBe(describeComparisonBlocker("oversize"));
  });

  it("retains the existing buttons when the comparison could not be described at all", () => {
    expect(planConflictRow(conflict(), null).mode).toBe("fallback");
    expect(planConflictRow(conflict(), undefined).mode).toBe("fallback");
    expect(planConflictRow(conflict(), null).fallback).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Compare & resolve dialog                                            *
 * ------------------------------------------------------------------ */

function comparisonWith(heads: Array<{ recordId: string; deviceId: string }>, over: Partial<HistoryConflictComparison> = {}): HistoryConflictComparison {
  return {
    entityId: "entity-1",
    namespace: "content",
    path: "Notes/a.md",
    reason: "Concurrent edits",
    heads: heads.map((head) => ({ ...head, kind: "file" as const, deleted: false, name: "a.md", parentId: null, size: 12, sha256: `sha-${head.recordId}` })),
    local: { path: "Notes/a.md", present: true, sha256: "local-sha", size: 12 },
    comparable: true,
    ...over,
  };
}

const HEADS = [
  { recordId: "9c1d0000-0000-0000-0000-000000000000", deviceId: "a3f2b1c4-0000-0000-0000-000000000000" },
  { recordId: "7e440000-0000-0000-0000-000000000000", deviceId: "5d6e7f80-0000-0000-0000-000000000000" },
  { recordId: "22110000-0000-0000-0000-000000000000", deviceId: "b0b00000-0000-0000-0000-000000000000" },
];

function dialog(options: {
  comparison?: HistoryConflictComparison;
  describe?: ConflictCompareSyncApi["describeHistoryConflict"];
  read?: ConflictCompareSyncApi["readHistoryConflictText"];
  resolve?: ConflictCompareSyncApi["resolveHistoryConflict"];
  settleLocalEdits?: (path: string) => Promise<string | null>;
} = {}) {
  const value = options.comparison ?? comparisonWith(HEADS.slice(0, 2));
  const describe = vi.fn(options.describe ?? (async () => value));
  const read = vi.fn(options.read ?? (async (_entityId: string, choice: { kind: string }) => (choice.kind === "current" ? "local text" : "synced text")));
  const resolve = vi.fn(options.resolve ?? (async () => ({})));
  const onResolved = vi.fn();
  const sync: ConflictCompareSyncApi = {
    describeHistoryConflict: describe,
    readHistoryConflictText: read,
    resolveHistoryConflict: resolve,
  };
  const opener = el("button");
  doc.body.appendChild(fake(opener));
  fake(opener).focus();
  const modal = new ConflictCompareModal({} as App, {
    entityId: "entity-1",
    path: "Notes/a.md",
    sync,
    onResolved,
    ...(options.settleLocalEdits ? { settleLocalEdits: options.settleLocalEdits } : {}),
  });
  return {
    modal, describe, read, resolve, onResolved, opener,
    root: () => modal.containerEl,
    button: (text: string) => fake(modal.containerEl).tree().find((item) => item.tagName === "button" && item.textContent === text)!,
    select: () => find(modal.containerEl, "sync-conflict-version-select")!,
    localText: () => all(modal.containerEl, "sync-conflict-panel-text")[0]?.textContent,
    remoteText: () => all(modal.containerEl, "sync-conflict-panel-text")[1]?.textContent,
    message: () => find(modal.containerEl, "sync-conflict-message")?.textContent ?? "",
    async open() {
      modal.open();
      await settle();
    },
  };
}

describe("compare & resolve dialog structure", () => {
  it("renders the approved title, read-only subtitle, two panels and three footer actions", async () => {
    const h = dialog();
    await h.open();
    expect(find(h.root(), "sync-conflict-title")!.textContent).toBe(SYNC_CONFLICT_DIALOG_TITLE);
    expect(find(h.root(), "sync-conflict-subtitle")!.textContent).toBe(SYNC_CONFLICT_DIALOG_SUBTITLE);
    const panels = all(h.root(), "sync-conflict-panel-title").map((item) => item.textContent);
    expect(panels).toEqual([SYNC_CONFLICT_LOCAL_PANEL_TITLE, SYNC_CONFLICT_REMOTE_PANEL_TITLE]);
    const actions = fake(find(h.root(), "sync-conflict-actions")).children.map((item) => item.textContent);
    expect(actions).toEqual([SYNC_CONFLICT_CANCEL_LABEL, SYNC_CONFLICT_KEEP_LOCAL_LABEL, SYNC_CONFLICT_USE_REMOTE_LABEL]);
  });

  it("gives the local panel no version selector and the synced panel one", async () => {
    const h = dialog();
    await h.open();
    const selects = fake(h.root()).tree().filter((item) => item.tagName === "select");
    expect(selects).toHaveLength(1);
    expect(fake(all(h.root(), "sync-conflict-panel")[1]).contains(selects[0])).toBe(true);
    expect(fake(all(h.root(), "sync-conflict-panel")[0]).contains(selects[0])).toBe(false);
  });

  it("lists every head, including more than two, with device-style labels", async () => {
    const h = dialog({ comparison: comparisonWith(HEADS) });
    await h.open();
    const options = fake(h.select()).children;
    expect(options.map((option) => option.value)).toEqual(HEADS.map((head) => head.recordId));
    expect(options.map((option) => option.textContent)).toEqual(["Device A3F2", "Device 5D6E", "Device B0B0"]);
  });

  it("performs no resolution while opening, comparing or cancelling", async () => {
    const h = dialog({ comparison: comparisonWith(HEADS) });
    await h.open();
    fake(h.select()).value = HEADS[2].recordId;
    fake(h.select()).dispatch("change");
    await settle();
    h.button(SYNC_CONFLICT_CANCEL_LABEL).click();
    await settle();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.onResolved).not.toHaveBeenCalled();
    expect(fake(h.root()).isConnected).toBe(false);
  });

  it("loads the selected synced version lazily, one read per selection", async () => {
    const h = dialog({ comparison: comparisonWith(HEADS) });
    h.modal.open();
    // Before the describe/read promises settle the panel shows a loading state.
    expect(h.remoteText()).toBe("Loading…");
    await settle();
    expect(h.localText()).toBe("local text");
    expect(h.remoteText()).toBe("synced text");
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.read).toHaveBeenNthCalledWith(1, "entity-1", { kind: "current" });
    expect(h.read).toHaveBeenNthCalledWith(2, "entity-1", { kind: "version", recordId: HEADS[0].recordId });
    fake(h.select()).value = HEADS[2].recordId;
    fake(h.select()).dispatch("change");
    await settle();
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.read).toHaveBeenNthCalledWith(3, "entity-1", { kind: "version", recordId: HEADS[2].recordId });
  });
});

describe("compare & resolve dialog resolution", () => {
  it("keeps this device's version with the reviewed local hash", async () => {
    const h = dialog();
    await h.open();
    h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).click();
    await settle();
    expect(h.resolve).toHaveBeenCalledWith({
      entityId: "entity-1",
      heads: [HEADS[0].recordId, HEADS[1].recordId],
      choice: { kind: "current" },
      reviewedLocalSha256: "local-sha",
    });
    expect(h.onResolved).toHaveBeenCalledTimes(1);
    expect(fake(h.root()).isConnected).toBe(false);
  });

  it("uses the selected synced version", async () => {
    const h = dialog({ comparison: comparisonWith(HEADS) });
    await h.open();
    fake(h.select()).value = HEADS[2].recordId;
    fake(h.select()).dispatch("change");
    await settle();
    h.button(SYNC_CONFLICT_USE_REMOTE_LABEL).click();
    await settle();
    expect(h.resolve).toHaveBeenCalledWith({
      entityId: "entity-1",
      heads: HEADS.map((head) => head.recordId),
      choice: { kind: "version", recordId: HEADS[2].recordId },
      reviewedLocalSha256: "local-sha",
    });
  });

  it("refuses to resolve when an unseen head arrived during comparison", async () => {
    const reviewed = comparisonWith(HEADS.slice(0, 2));
    const arrived = comparisonWith(HEADS);
    const describe = vi.fn().mockResolvedValueOnce(reviewed).mockResolvedValue(arrived);
    const h = dialog({ describe });
    await h.open();
    h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).click();
    await settle();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.message()).toBe(SYNC_CONFLICT_STALE_HEADS_MESSAGE);
    expect(fake(h.root()).isConnected).toBe(true);
    expect(h.onResolved).not.toHaveBeenCalled();
  });

  it("surfaces a stale local hash rejection and keeps the dialog open so the banner remains", async () => {
    const h = dialog({ resolve: async () => { throw new Error("Local file changed since it was reviewed"); } });
    await h.open();
    h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).click();
    await settle();
    expect(h.message()).toBe("Local file changed since it was reviewed");
    expect(fake(h.root()).isConnected).toBe(true);
    expect(h.onResolved).not.toHaveBeenCalled();
    expect(h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).disabled).toBe(false);
  });

  it("requires unsaved pane edits to be saved instead of guessing between dirty buffers", async () => {
    const blocked = "Save or refresh this note in every open pane before resolving.";
    const settleLocalEdits = vi.fn(async () => blocked);
    const h = dialog({ settleLocalEdits });
    await h.open();
    expect(h.message()).toBe(blocked);
    h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).click();
    await settle();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(settleLocalEdits).toHaveBeenCalledWith("Notes/a.md");
  });

  it("settles ordinary autosave before describing, so the reviewed hash is the saved one", async () => {
    const order: string[] = [];
    const settleLocalEdits = vi.fn(async () => { order.push("settle"); return null; });
    const h = dialog({ settleLocalEdits, describe: async () => { order.push("describe"); return comparisonWith(HEADS.slice(0, 2)); } });
    await h.open();
    expect(order).toEqual(["settle", "describe"]);
  });

  it("fires exactly one resolution for a double click", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolveGate) => { release = () => resolveGate(); });
    const h = dialog({ resolve: async () => { await gate; return {}; } });
    await h.open();
    const button = h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL);
    button.click();
    await settle();
    button.click();
    h.button(SYNC_CONFLICT_USE_REMOTE_LABEL).click();
    await settle();
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    release!();
    await settle();
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });
});

describe("compare & resolve dialog failure handling", () => {
  const failures = [
    "Comparison exceeds the inline size limit",
    "Stored bytes failed integrity verification",
    "missing blob",
    "Version text is not valid UTF-8",
    "Network request failed",
  ];

  it("renders every read failure class as a safe inline message without note contents", async () => {
    for (const failure of failures) {
      const h = dialog({ read: async () => { throw new Error(failure); } });
      await h.open();
      expect(h.message()).toBe(failure);
      expect(fake(h.root()).textContent).not.toContain("local text");
      expect(fake(h.root()).textContent).not.toContain("synced text");
      expect(fake(h.root()).isConnected).toBe(true);
      h.modal.close();
    }
  });

  it("renders a describe failure inline and leaves resolution disabled", async () => {
    const h = dialog({ describe: async () => { throw new Error("Conflict selection is stale"); } });
    await h.open();
    expect(h.message()).toBe("Conflict selection is stale");
    expect(h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).disabled).toBe(true);
    expect(h.button(SYNC_CONFLICT_USE_REMOTE_LABEL).disabled).toBe(true);
    expect(h.button(SYNC_CONFLICT_CANCEL_LABEL).disabled).toBe(false);
  });

  it("explains a non-comparable conflict and offers no resolution from the dialog", async () => {
    const h = dialog({ comparison: comparisonWith(HEADS.slice(0, 2), { comparable: false, notComparable: "rename-or-move" }) });
    await h.open();
    // The DIALOG variant, not the Settings variant: the Settings copy names
    // Keep local / Accept version, which are not in this dialog, are disabled,
    // and are not on screen — naming them would strand the user.
    expect(h.message()).toBe(describeComparisonBlockerForDialog("rename-or-move"));
    expect(h.message()).toContain("Settings");
    expect(h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).disabled).toBe(true);
    expect(h.button(SYNC_CONFLICT_USE_REMOTE_LABEL).disabled).toBe(true);
    expect(h.read).not.toHaveBeenCalled();
    // And neither panel may still claim to be loading something that will
    // never arrive: a rename between two devices is an ordinary conflict.
    expect(h.localText()).not.toBe(SYNC_CONFLICT_LOADING_TEXT);
    expect(h.remoteText()).not.toBe(SYNC_CONFLICT_LOADING_TEXT);
  });

  it("drops a pending read that lands after the dialog closed", async () => {
    let landRead: ((value: string) => void) | null = null;
    const h = dialog({
      read: async (_entityId, choice) => {
        if (choice.kind === "current") return "local text";
        return new Promise<string>((resolveRead) => { landRead = (value) => resolveRead(value); });
      },
    });
    await h.open();
    h.modal.close();
    expect(() => landRead!("late synced text")).not.toThrow();
    await settle();
    expect(fake(h.root()).textContent).not.toContain("late synced text");
    expect(fake(h.root()).isConnected).toBe(false);
  });

  it("cancels a pending read when the vault switches or the provider unloads", async () => {
    let landRead: ((value: string) => void) | null = null;
    const h = dialog({
      read: async (_entityId, choice) => {
        if (choice.kind === "current") return "local text";
        return new Promise<string>((resolveRead) => { landRead = (value) => resolveRead(value); });
      },
    });
    await h.open();
    expect(h.modal.entityId).toBe("entity-1");
    expect(h.modal.isClosed).toBe(false);
    h.modal.cancel();
    expect(h.modal.isClosed).toBe(true);
    landRead!("late synced text");
    await settle();
    expect(fake(h.root()).textContent).not.toContain("late synced text");
    expect(h.resolve).not.toHaveBeenCalled();
    h.modal.cancel();
    expect(h.modal.isClosed).toBe(true);
  });

  it("still reports a completed resolution when sync state closed the dialog first", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolveGate) => { release = () => resolveGate(); });
    const h = dialog({ resolve: async () => { await gate; return {}; } });
    await h.open();
    h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).click();
    await settle();
    // The conflict leaves sync state and the host dismisses the dialog while
    // the resolution is still in flight.
    h.modal.cancel();
    release!();
    await settle();
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.onResolved).toHaveBeenCalledTimes(1);
  });

  it("never issues two comparison reads at once against a single-owner slot", async () => {
    // Reproduces SyncService's real constraint: every comparison read takes the
    // sync controller's single-owner slot, and settled() only waits for work
    // that is ALREADY running. Two reads issued from a quiet service therefore
    // do not queue — the first claims the slot and withController rejects the
    // second outright. A fake that ignores this (a bare vi.fn) hid a defect
    // that made the dialog fail 100% of the time against the real service.
    let slotHeld = false;
    const h = dialog({
      comparison: comparisonWith(HEADS),
      read: async (_entityId, choice) => {
        if (slotHeld) throw new Error("Sync already running or disconnecting");
        slotHeld = true;
        try {
          await Promise.resolve();
          return choice.kind === "current" ? "local text" : "synced text";
        } finally {
          slotHeld = false;
        }
      },
    });
    await h.open();
    expect(h.message()).toBe("");
    expect(h.localText()).toBe("local text");
    expect(h.remoteText()).toBe("synced text");
    expect(h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL).disabled).toBe(false);
    expect(h.button(SYNC_CONFLICT_USE_REMOTE_LABEL).disabled).toBe(false);
  });

  it("drops a superseded read when the selection changes before it lands", async () => {
    const pending = new Map<string, (value: string) => void>();
    let inFlight = 0;
    let peakInFlight = 0;
    const h = dialog({
      comparison: comparisonWith(HEADS),
      read: async (_entityId, choice) => {
        if (choice.kind === "current") return "local text";
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        return new Promise<string>((resolveRead) =>
          pending.set(choice.recordId, (value) => {
            inFlight -= 1;
            resolveRead(value);
          }),
        );
      },
    });
    await h.open();
    // The first head's read is still in flight. Selecting another head must
    // QUEUE behind it, never race it: each read takes the sync controller's
    // single-owner slot, and two concurrent reads collide outright rather than
    // waiting for one another.
    fake(h.select()).value = HEADS[2].recordId;
    fake(h.select()).dispatch("change");
    await settle();
    expect(pending.has(HEADS[2].recordId)).toBe(false);
    // The superseded first read lands late; it must not paint the panel.
    pending.get(HEADS[0].recordId)!("first version");
    await settle();
    expect(h.remoteText()).not.toBe("first version");
    pending.get(HEADS[2].recordId)!("third version");
    await settle();
    expect(h.remoteText()).toBe("third version");
    // The guarantee the serialization exists for.
    expect(peakInFlight).toBe(1);
  });
});

describe("compare & resolve dialog accessibility", () => {
  it("marks itself as a modal dialog with an accessible name", async () => {
    const h = dialog();
    await h.open();
    const modalEl = fake(h.modal.modalEl);
    expect(modalEl.getAttribute("role")).toBe("dialog");
    expect(modalEl.getAttribute("aria-modal")).toBe("true");
    const labelledBy = modalEl.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(find(h.root(), "sync-conflict-title")!.getAttribute("id")).toBe(labelledBy);
  });

  it("focuses inside the dialog on open and restores the opener on close", async () => {
    const h = dialog();
    await h.open();
    expect(fake(h.root()).contains(doc.activeElement)).toBe(true);
    h.modal.close();
    expect(doc.activeElement).toBe(fake(h.opener));
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    const h = dialog({ comparison: comparisonWith(HEADS) });
    await h.open();
    // DOM/reading order. Both text panels are tab stops on purpose: they are
    // overflow:auto with a max-height, so without a stop a keyboard-only user
    // could not scroll a long note into view.
    const panels = all(h.root(), "sync-conflict-panel-text");
    const focusables = [
      panels[0],
      h.select(),
      panels[1],
      h.button(SYNC_CONFLICT_CANCEL_LABEL),
      h.button(SYNC_CONFLICT_KEEP_LOCAL_LABEL),
      h.button(SYNC_CONFLICT_USE_REMOTE_LABEL),
    ];
    expect(panels.every((panel) => fake(panel).tabIndex === 0)).toBe(true);
    focusables[focusables.length - 1].focus();
    const forward = doc.dispatch("keydown", { key: "Tab" });
    expect(forward.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(focusables[0]);
    const backward = doc.dispatch("keydown", { key: "Tab", shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(focusables[focusables.length - 1]);
  });

  it("detaches its document listeners on close so nothing leaks", async () => {
    const before = doc.listenerCount("keydown");
    const h = dialog();
    await h.open();
    expect(doc.listenerCount("keydown")).toBeGreaterThan(before);
    h.modal.close();
    expect(doc.listenerCount("keydown")).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * Integration contracts that cannot be exercised without Electron     *
 * ------------------------------------------------------------------ */

describe("markdown view wiring", () => {
  const view = source("src/renderer/views/markdown-view.ts");

  it("mounts the sync banner in its own slot above the body, not in the recovery banner's slot", () => {
    expect(view).toMatch(/new SyncConflictBannerSlot\(this\.containerEl, this\.bodyEl\)/);
    expect(view).toMatch(/presentSyncConflict\(/);
    expect(view).toMatch(/clearSyncConflict\(\)/);
    // The pre-existing external-edit banner keeps its own field and its own slot.
    expect(view).toMatch(/this\.containerEl\.prepend\(banner\)/);
  });

  it("never makes the note read-only for a sync conflict", () => {
    // The method body: from its declaration to the first closing brace at
    // method indentation.
    const body = /\n  presentSyncConflict\([\s\S]*?\n  \}/.exec(view)?.[0];
    expect(body).toBeTruthy();
    expect(body).toContain("syncConflictSlot.present");
    expect(body).not.toContain("conflictReadOnly");
    expect(body).not.toContain("contenteditable");
    expect(body).not.toContain("aria-readonly");
    // The recovery banner keeps sole ownership of read-only mode.
    expect(/\n  presentConflict\([\s\S]*?\n  \}/.exec(view)?.[0]).toContain("this.conflictReadOnly = true");
  });

  it("drops the banner when the pane changes file or closes", () => {
    const setFile = view.slice(view.indexOf("async setFile("), view.indexOf("beginTitleRename()"));
    expect(setFile).toContain("this.clearSyncConflict()");
    const onClose = view.slice(view.indexOf("async onClose("));
    expect(onClose).toContain("this.clearSyncConflict()");
  });
});

describe("settings sync tab wiring", () => {
  const app = source("src/renderer/app.ts");

  it("replaces the per-head buttons with one compare action for comparable conflicts", () => {
    expect(app).toContain("planConflictRow");
    expect(app).toContain("SYNC_CONFLICT_COMPARE_LABEL");
    expect(app).toContain("ConflictCompareModal");
    expect(app).toContain("row.control.replaceChildren(compare)");
  });

  it("reconciles banners and the open dialog from sync status, file-open and layout", () => {
    expect(app).toMatch(/this\.sync\.on\("status", refreshConflictBanners\)/);
    expect(app).toMatch(/this\.workspace\.on\("file-open", refreshConflictBanners\)/);
    expect(app).toMatch(/this\.workspace\.on\("layout-change", refreshConflictBanners\)/);
    // Teardown path: stop listening, dismiss any open dialog, clear banners.
    const disposer = /this\.hostDisposers\.add\(\(\) => \{\n      stopSyncStatus\(\);[\s\S]*?\n    \}\);/.exec(app)?.[0];
    expect(disposer).toContain("this.openConflictModal?.cancel()");
    expect(disposer).toContain("conflictBanners.dispose()");
  });

  it("settles autosave and refuses to choose between dirty panes", () => {
    const settleFn = /private async settleSyncConflictEdits\([\s\S]*?\n  \}/.exec(app)?.[0];
    expect(settleFn).toBeTruthy();
    expect(settleFn).toContain("view.flush()");
    expect(settleFn).toContain("view.waitForPendingSave()");
    expect(settleFn).toContain("view.hasPendingSave()");
    expect(settleFn).toContain("view.hasUnacknowledgedChanges()");
  });

  it("leaves the legacy conditional-provider conflict list untouched", () => {
    expect(app).toContain('[["Keep local", "keep-local"], ["Accept remote", "accept-remote"]]');
    expect(app).toContain("Deleted remotely. Keep local uploads this file again");
  });
});

describe("conflict styles", () => {
  const css = source("styles/app.css");

  it("styles the sync banner in the advisory amber family using theme variables", () => {
    expect(css).toMatch(/\.sync-conflict-banner\b/);
    expect(css).toMatch(/\.sync-conflict-banner[\s\S]{0,400}var\(--color-orange\)/);
    expect(css).toMatch(/\.sync-conflict-banner[\s\S]{0,400}var\(--background-primary\)/);
  });

  it("stacks the comparison panels at narrow widths and sits them side by side otherwise", () => {
    expect(css).toMatch(/\.sync-conflict-compare\s*\{[\s\S]{0,300}grid-template-columns:\s*1fr 1fr/);
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.sync-conflict-compare[\s\S]{0,200}grid-template-columns:\s*1fr/);
  });
});

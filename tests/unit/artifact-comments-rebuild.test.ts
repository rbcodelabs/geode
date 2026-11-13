import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  rebuildBatchReport,
  rebuildChange,
  rebuildComment,
  rebuildDetail,
  rebuildResult,
  rebuildSelection,
  rebuildSnapshot,
} from "../../src/renderer/artifacts/comments-rebuild";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "artifact-feedback");
const load = (name: string): any => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** Applies one junk-fixture patch. Supports dotted paths, "" (whole value), $delete, REPEAT:<char>:<n> and COPY:<path>. */
function applyPatch(root: any, patch: { path: string; value: any }): any {
  const resolve = (value: any): any => {
    if (value && typeof value === "object" && value.$delete === true) return undefined;
    if (typeof value === "string" && value.startsWith("REPEAT:")) {
      const [, ch, n] = value.split(":");
      return (ch as string).repeat(Number(n));
    }
    return value;
  };
  if (patch.path === "") return resolve(patch.value);
  const keys = patch.path.split(".");
  let holder = root;
  for (const key of keys.slice(0, -1)) holder = holder[key];
  const last = keys[keys.length - 1] as string;
  if (typeof patch.value === "string" && patch.value.startsWith("COPY:")) {
    let src = root;
    for (const key of patch.value.slice(5).split(".")) src = src[key];
    holder[last] = clone(src);
    return root;
  }
  const next = resolve(patch.value);
  if (next === undefined) delete holder[last];
  else holder[last] = next;
  return root;
}

describe("golden fixtures rebuild to themselves", () => {
  it("comment", () => {
    const raw = load("comment.json");
    expect(rebuildComment(raw)).toEqual(raw);
  });
  it("snapshot", () => {
    const raw = load("snapshot.json");
    expect(rebuildSnapshot(raw)).toEqual(raw);
  });
  it("detail with and without a selection", () => {
    const withSelection = { comment: load("comment.json"), selection: load("selection.json") };
    expect(rebuildDetail(withSelection)).toEqual(withSelection);
    expect(rebuildDetail(load("detail.json"))).toEqual(load("detail.json"));
    expect(rebuildDetail({ comment: load("comment.json"), selection: null })).toEqual({ comment: load("comment.json"), selection: null });
  });
  it("batch report", () => {
    const raw = load("batch-report.json");
    expect(rebuildBatchReport(raw)).toEqual(raw);
  });
  it("change", () => {
    const raw = load("change.json");
    expect(rebuildChange(raw)).toEqual(raw);
    expect(rebuildChange({ ...raw, ids: "all", reason: "recovered" })).toMatchObject({ ids: "all", reason: "recovered" });
  });
});

describe("junk snapshots are rejected whole", () => {
  const { cases } = load("junk-snapshots.json") as { cases: { name: string; patches: { path: string; value: any }[] }[] };
  it("has a meaningful table", () => expect(cases.length).toBeGreaterThanOrEqual(40));
  for (const junk of cases) {
    it(junk.name, () => {
      let value: any = clone(load("snapshot.json"));
      for (const patch of junk.patches) value = applyPatch(value, patch);
      expect(rebuildSnapshot(value)).toBeNull();
    });
  }

  it("rejects values JSON cannot carry: NaN, Infinity, class instances, getters, symbols, functions", () => {
    const withMutation = (mutate: (snapshot: any) => void): unknown => { const s = clone(load("snapshot.json")); mutate(s); return s; };
    expect(rebuildSnapshot(withMutation((s) => { s.revision = Number.NaN; }))).toBeNull();
    expect(rebuildSnapshot(withMutation((s) => { s.revision = Number.POSITIVE_INFINITY; }))).toBeNull();
    expect(rebuildSnapshot(withMutation((s) => { s.comments[0].anchor.lastRect.x = Number.NaN; }))).toBeNull();
    expect(rebuildSnapshot(withMutation((s) => { s.comments[0] = Object.assign(new (class Evil {})(), s.comments[0]); }))).toBeNull();
    expect(rebuildSnapshot(withMutation((s) => { s.comments[0].text = () => "x"; }))).toBeNull();
    expect(rebuildSnapshot(withMutation((s) => { s.comments[0].text = Symbol("x"); }))).toBeNull();
    let reads = 0;
    expect(rebuildSnapshot(withMutation((s) => {
      Object.defineProperty(s.comments[0], "text", { enumerable: true, get() { reads += 1; throw new Error("boom"); } });
    }))).toBeNull();
    expect(reads).toBe(0); // accessor properties are refused without being invoked
    expect(rebuildSnapshot(new Proxy({}, { get() { throw new Error("proxy trap"); }, getPrototypeOf() { throw new Error("proxy trap"); } }))).toBeNull();
  });

  it("rejects hostile own keys such as __proto__ and constructor on any object", () => {
    const raw = JSON.parse(JSON.stringify(load("snapshot.json")).replace('"health"', '"__proto__":{"polluted":true},"health"'));
    expect(Object.prototype.hasOwnProperty.call(raw, "__proto__")).toBe(true);
    expect(rebuildSnapshot(raw)).toBeNull();
    expect(({} as any).polluted).toBeUndefined();
    const nested = clone(load("comment.json"));
    Object.defineProperty(nested.anchor, "constructor", { enumerable: true, value: {} });
    expect(rebuildComment(nested)).toBeNull();
  });
});

describe("allowlist rebuild", () => {
  it("drops unknown fields at every level and shares no references with the input", () => {
    const raw = clone(load("snapshot.json"));
    raw.extra = "x";
    raw.comments[0].secret = "s";
    raw.comments[0].anchor.extra = 1;
    raw.comments[0].send.extra = 1;
    raw.comments[0].anchor.lastRect.extra = 1;
    const out = rebuildSnapshot(raw)!;
    expect(out).toEqual(load("snapshot.json"));
    expect(out.comments[0]).not.toBe(raw.comments[0]);
    raw.comments[0].text = "mutated after the fact";
    raw.comments[0].anchor.selectorAlternates.push("x");
    expect(out.comments[0]!.text).toBe("Make this primary action larger.");
    expect(out.comments[0]!.anchor.selectorAlternates).toEqual(["#save"]);
  });

  it("freezes plain parts of the result", () => {
    const out = rebuildSnapshot(load("snapshot.json"))!;
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.comments)).toBe(true);
    expect(Object.isFrozen(out.comments[0])).toBe(true);
    expect(Object.isFrozen(out.comments[0]!.anchor.selectorAlternates)).toBe(true);
  });

  it("strips control characters and truncates display strings (notice 300, label 120, lastMessage 500)", () => {
    const raw = clone(load("snapshot.json"));
    raw.health = "recovered";
    raw.notice = `a\u0000b\u202ec\n${"n".repeat(400)}`;
    raw.comments[0].label = `L${"x".repeat(300)}`;
    raw.comments[0].send.lastMessage = `m\u0007${"y".repeat(900)}`;
    const out = rebuildSnapshot(raw)!;
    expect(out.notice!.length).toBe(300);
    expect(out.notice).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(out.comments[0]!.label.length).toBe(120);
    expect(out.comments[0]!.send.lastMessage!.length).toBe(500);
    expect(out.comments[0]!.send.lastMessage).not.toMatch(/\u0007/);
  });

  it("keeps newlines and tabs in comment text but strips other controls", () => {
    const raw = clone(load("comment.json"));
    raw.text = "line one\nline two\tTab\u0000\u0007 done";
    expect(rebuildComment(raw)!.text).toBe("line one\nline two\tTab done");
  });

  it("accepts text of exactly 4000 units and rejects 4001", () => {
    const raw = clone(load("comment.json"));
    raw.text = "t".repeat(4000);
    expect(rebuildComment(raw)).not.toBeNull();
    raw.text = "t".repeat(4001);
    expect(rebuildComment(raw)).toBeNull();
  });

  it("tolerates a well-formed kind it does not know (13e: consumers must tolerate unknown kinds) and keeps text-edit", () => {
    const raw = clone(load("comment.json"));
    raw.kind = "text-edit";
    expect(rebuildComment(raw)!.kind).toBe("text-edit");
    raw.kind = "future-kind";
    expect(rebuildComment(raw)!.kind).toBe("future-kind");
  });

  it("sorts by ordinal ascending and caps at 200 comments", () => {
    const base = load("comment.json");
    const make = (n: number) => {
      const hex = n.toString(16).padStart(32, "0");
      return { ...clone(base), id: `cmt_${hex}`, selectionId: `sel_${hex}`, ordinal: n };
    };
    const snapshot = { ...clone(load("snapshot.json")), foreignCount: 0, comments: [make(3), make(1), make(2)] };
    expect(rebuildSnapshot(snapshot)!.comments.map((c) => c.ordinal)).toEqual([1, 2, 3]);
    const many = { ...snapshot, comments: Array.from({ length: 250 }, (_, i) => make(i + 1)) };
    const out = rebuildSnapshot(many)!;
    expect(out.comments).toHaveLength(200);
    expect(out.comments[199]!.ordinal).toBe(200);
  });

  it("accepts an empty selector and empty text anchor (redacted pins)", () => {
    const raw = clone(load("snapshot.json"));
    expect(rebuildSnapshot(raw)!.comments[1]!.anchor.selector).toBe("");
  });
});

describe("selection rebuild (get)", () => {
  const sel = () => clone(load("selection.json"));
  it("drops computed style keys outside the 40-name allowlist", () => {
    const raw = sel();
    raw.computedStyles["--evil"] = "x";
    raw.computedStyles["content"] = "y";
    expect(rebuildSelection(raw)!.computedStyles).toEqual({ display: "inline-block", color: "rgb(0, 0, 0)" });
  });
  const bad: [string, (s: any) => void][] = [
    ["schemaVersion 2", (s) => { s.schemaVersion = 2; }],
    ["selectionId malformed", (s) => { s.selectionId = "../x"; }],
    ["viewportPreset unknown", (s) => { s.viewportPreset = "watch"; }],
    ["tag upper-case", (s) => { s.tag = "BUTTON"; }],
    ["outerHTML over 4096", (s) => { s.outerHTML.html = "h".repeat(4097); }],
    ["four ancestors", (s) => { s.ancestors = [1, 2, 3, 4].map(() => ({ tag: "div", id: null, classes: [] })); }],
    ["nine classes", (s) => { s.ancestors[0].classes = Array.from({ length: 9 }, () => "c"); }],
    ["style value over 200", (s) => { s.computedStyles.display = "d".repeat(201); }],
    ["bounding box NaN", (s) => { s.boundingBox.viewport.x = Number.NaN; }],
    ["bounding box 1e7", (s) => { s.boundingBox.document.y = 1e7; }],
    ["tabIndex out of range", (s) => { s.a11y.tabIndex = 40000; }],
    ["capturedAt not ISO", (s) => { s.capturedAt = "noon"; }],
    ["devicePixelRatio zero", (s) => { s.viewport.devicePixelRatio = 0; }],
  ];
  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, () => {
      const raw = sel();
      mutate(raw);
      expect(rebuildSelection(raw)).toBeNull();
      const detail = { comment: load("comment.json"), selection: raw };
      expect(rebuildDetail(detail)).toBeNull();
    });
  }
});

describe("batch report and change events", () => {
  it("requires reason iff skipped, a valid outcome and at most 20 items", () => {
    const base = () => clone(load("batch-report.json"));
    const a = base(); delete a.items[1].reason; expect(rebuildBatchReport(a)).toBeNull();
    const b = base(); b.items[0].reason = "foreign"; expect(rebuildBatchReport(b)).toBeNull();
    const c = base(); c.outcome = "done"; expect(rebuildBatchReport(c)).toBeNull();
    const d = base(); d.requestId = "req_x"; expect(rebuildBatchReport(d)).toBeNull();
    const e = base(); e.items = Array.from({ length: 21 }, (_, i) => ({ id: `cmt_${i.toString(16).padStart(32, "0")}`, result: "sent" })); expect(rebuildBatchReport(e)).toBeNull();
    const f = base(); f.items[0].id = "cmt_../x"; expect(rebuildBatchReport(f)).toBeNull();
    const g = base(); g.items[0].result = "maybe"; expect(rebuildBatchReport(g)).toBeNull();
    const h = base(); h.message = `ok\u0000${"m".repeat(700)}`; expect(rebuildBatchReport(h)!.message.length).toBe(500);
  });
  it("rejects malformed change events", () => {
    const base = () => clone(load("change.json"));
    const a = base(); a.reason = "weather"; expect(rebuildChange(a)).toBeNull();
    const b = base(); b.ids = ["../x"]; expect(rebuildChange(b)).toBeNull();
    const c = base(); c.ids = "some"; expect(rebuildChange(c)).toBeNull();
    const d = base(); d.revision = -1; expect(rebuildChange(d)).toBeNull();
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `cmt_${i.toString(16).padStart(32, "0")}`);
    const e = base(); e.ids = ids(201); expect(rebuildChange(e)).toBeNull();
    const f = base(); f.ids = ids(200); expect(rebuildChange(f)).not.toBeNull();
    expect(rebuildChange(null)).toBeNull();
  });
});

describe("rebuildResult", () => {
  const ident = (v: unknown) => (typeof v === "number" ? v : null);
  it("passes ok values through the value rebuilder", () => {
    expect(rebuildResult({ status: "ok", value: 3, extra: 1 }, ident)).toEqual({ status: "ok", value: 3 });
    expect(rebuildResult({ status: "ok", value: "x" }, ident)).toBeNull();
  });
  it("cleans rejected messages and rejects unknown reasons", () => {
    expect(rebuildResult({ status: "rejected", reason: "conflict", message: `no\u0000pe${"z".repeat(600)}` }, ident)).toEqual({
      status: "rejected", reason: "conflict", message: `nope${"z".repeat(496)}`,
    });
    expect(rebuildResult({ status: "rejected", reason: "exploded", message: "x" }, ident)).toBeNull();
    expect(rebuildResult({ status: "rejected", reason: "busy" }, ident)).toBeNull();
    expect(rebuildResult({ status: "maybe" }, ident)).toBeNull();
    expect(rebuildResult(undefined, ident)).toBeNull();
  });
  it("accepts every documented reject reason", () => {
    for (const reason of ["not-found", "conflict", "invalid", "invalid-transition", "limit", "read-only", "foreign", "busy", "unavailable", "failed"]) {
      expect(rebuildResult({ status: "rejected", reason, message: "m" }, ident)).toMatchObject({ reason });
    }
  });
});

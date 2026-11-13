import * as fs from "node:fs";
import * as path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { CommentsRail } from "../../src/renderer/artifacts/comments-rail";
import { buildRailView, type RailInput } from "../../src/renderer/artifacts/rail-model";
import { comment, idOf } from "./helpers/pin-fixtures";

vi.setConfig({ testTimeout: 30_000 });

const input = (over: Partial<RailInput> = {}): RailInput => ({
  comments: [], anchorStates: {}, filter: "all", clusterIds: null, selected: null, notice: null, health: "ok", resultsLine: null, ...over,
});

function mount() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;
  const cb = {
    onFilter: vi.fn(), onClearCluster: vi.fn(), onToggleSelect: vi.fn(), onAction: vi.fn(), onSendSelected: vi.fn(),
    onResolveSent: vi.fn(), onAdoptAll: vi.fn(), onRetry: vi.fn(), onClose: vi.fn(),
  };
  const rail = new CommentsRail(doc, cb);
  doc.body.append(rail.el);
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => rail.el.querySelector<T>(sel)!;
  const qa = <T extends HTMLElement = HTMLElement>(sel: string) => [...rail.el.querySelectorAll<T>(sel)];
  const press = (el: Element, key: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  const show = (over: Partial<RailInput> = {}) => rail.render(buildRailView(input(over)));
  return { dom, doc, rail, cb, q, qa, press, show };
}
const sev = (n: number) => Array.from({ length: n }, (_, i) => comment(i + 1));

describe("CommentsRail structure and a11y", () => {
  it("is an aside with an accessible name, a focusable heading and a labelled close button", () => {
    const { rail, q, show } = mount();
    show({ comments: sev(3) });
    expect(rail.el.tagName).toBe("ASIDE");
    expect(rail.el.getAttribute("aria-label")).toBe("Design comments");
    expect(q("h2").textContent).toBe("Comments (3)");
    expect(q("h2").getAttribute("tabindex")).toBe("-1");
    expect(q(".comments-rail-close").getAttribute("aria-label")).toBe("Close comments");
  });

  it("filters are a group of aria-pressed buttons", () => {
    const { qa, q, cb, show } = mount();
    show({ comments: sev(2), filter: "open" });
    expect(q(".comments-rail-filters").getAttribute("role")).toBe("group");
    const buttons = qa<HTMLButtonElement>(".comments-rail-filter");
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false", "false"]);
    buttons[2]!.click();
    expect(cb.onFilter).toHaveBeenCalledWith("sent");
  });

  it("the results line and notice are live regions", () => {
    const { q, show } = mount();
    show({ comments: sev(1), resultsLine: "2 sent, 1 waiting for the agent", notice: "Recovered.", health: "recovered" });
    expect(q(".comments-rail-results").getAttribute("role")).toBe("status");
    expect(q(".comments-rail-results").textContent).toBe("2 sent, 1 waiting for the agent");
    expect(q(".comments-rail-notice").textContent).toBe("Recovered.");
    expect(q(".comments-rail-notice").hidden).toBe(false);
  });

  it("never uses innerHTML anywhere in the module", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "renderer", "artifacts", "comments-rail.ts"), "utf8");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    const overlay = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "renderer", "artifacts", "pin-overlay.ts"), "utf8");
    expect(overlay).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("renders hostile label and text as text", () => {
    const { rail, show } = mount();
    show({ comments: [comment(1, { text: "<img src=x onerror=alert(1)>", label: "<script>alert(1)</script>" })] });
    expect(rail.el.querySelector("img")).toBeNull();
    expect(rail.el.querySelector("script")).toBeNull();
    expect(rail.el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("CommentsRail rows", () => {
  it("shows ordinal, status text, label, text and chips", () => {
    const { q, show } = mount();
    show({ comments: [comment(4, { status: "pending", text: "Make it bigger" })], anchorStates: { [idOf(4)]: "approximate" } });
    const row = q(".comments-rail-row");
    expect(row.dataset.status).toBe("pending");
    expect(row.querySelector(".comments-rail-ordinal")!.textContent).toBe("4");
    expect(row.querySelector(".comments-rail-text")!.textContent).toBe("Make it bigger");
    expect(row.textContent).toContain("Waiting for the agent");
    expect(row.textContent).toContain("Approximate: may not be the same element");
  });

  it("row actions have accessible names that include the comment number and call onAction", () => {
    const { qa, cb, show } = mount();
    show({ comments: [comment(7)], anchorStates: { [idOf(7)]: "exact" } });
    const names = qa<HTMLButtonElement>(".comments-rail-row .comments-rail-action").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Jump to comment 7", "Send comment 7", "Resolve comment 7", "Dismiss comment 7", "Delete comment 7"]);
    qa<HTMLButtonElement>(".comments-rail-action")[2]!.click();
    expect(cb.onAction).toHaveBeenCalledWith(idOf(7), "resolve");
  });

  it("delete needs an inline confirmation", () => {
    const { qa, q, cb, show } = mount();
    show({ comments: [comment(1)] });
    qa<HTMLButtonElement>(".comments-rail-action").find((b) => b.dataset.action === "delete")!.click();
    expect(cb.onAction).not.toHaveBeenCalled();
    expect(q(".comments-rail-confirm").textContent).toMatch(/Delete comment 1/);
    q<HTMLButtonElement>(".comments-rail-confirm-no").click();
    expect(q(".comments-rail-confirm")).toBeNull();
    expect(cb.onAction).not.toHaveBeenCalled();
    qa<HTMLButtonElement>(".comments-rail-action").find((b) => b.dataset.action === "delete")!.click();
    q<HTMLButtonElement>(".comments-rail-confirm-yes").click();
    expect(cb.onAction).toHaveBeenCalledWith(idOf(1), "delete");
  });

  it("unqueue confirms with the size of the queued batch", () => {
    const { qa, q, cb, show } = mount();
    show({ comments: [comment(1, { status: "pending" }), comment(2, { status: "pending" })] });
    qa<HTMLButtonElement>(".comments-rail-action").find((b) => b.dataset.action === "unqueue")!.click();
    expect(q(".comments-rail-confirm").textContent).toMatch(/Cancels the queued send of 2 comments/);
    q<HTMLButtonElement>(".comments-rail-confirm-yes").click();
    expect(cb.onAction).toHaveBeenCalledWith(idOf(1), "unqueue");
  });

  it("selection checkbox has the documented label and reports changes", () => {
    const { q, cb, show } = mount();
    show({ comments: [comment(4)] });
    const box = q<HTMLInputElement>(".comments-rail-select");
    expect(box.getAttribute("aria-label")).toBe("Select comment 4 for sending");
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new (box.ownerDocument.defaultView!.Event)("change", { bubbles: true }));
    expect(cb.onToggleSelect).toHaveBeenCalledWith(idOf(4), false);
  });

  it("sent and foreign rows have no checkbox", () => {
    const { qa, show } = mount();
    show({ comments: [comment(1, { status: "sent" }), comment(2, { provenance: "foreign" })] });
    expect(qa(".comments-rail-select")).toHaveLength(0);
  });

  it("greys detached rows", () => {
    const { q, show } = mount();
    show({ comments: [comment(1)], anchorStates: { [idOf(1)]: "detached" } });
    expect(q(".comments-rail-row").classList.contains("is-greyed")).toBe(true);
  });
});

describe("CommentsRail send bar, banners and cluster chip", () => {
  it("Send N calls onSendSelected; disabled at zero", () => {
    const { q, cb, show } = mount();
    show({ comments: sev(2) });
    const send = q<HTMLButtonElement>(".comments-rail-send");
    expect(send.textContent).toBe("Send 2");
    expect(send.getAttribute("aria-label")).toBe("Send 2 selected comments");
    send.click();
    expect(cb.onSendSelected).toHaveBeenCalledTimes(1);
    show({ comments: sev(2), selected: new Set() });
    expect(send.disabled).toBe(true);
  });

  it("Resolve sent appears only with sent comments", () => {
    const { q, cb, show } = mount();
    show({ comments: [comment(1)] });
    expect(q(".comments-rail-resolve-sent").hidden).toBe(true);
    show({ comments: [comment(1, { status: "sent" })] });
    expect(q(".comments-rail-resolve-sent").hidden).toBe(false);
    q<HTMLButtonElement>(".comments-rail-resolve-sent").click();
    expect(cb.onResolveSent).toHaveBeenCalled();
  });

  it("foreign banner has Adopt all", () => {
    const { q, cb, show } = mount();
    show({ comments: [comment(1, { provenance: "foreign" })] });
    expect(q(".comments-rail-foreign").hidden).toBe(false);
    q<HTMLButtonElement>(".comments-rail-adopt-all").click();
    expect(cb.onAdoptAll).toHaveBeenCalled();
  });

  it("retry button shows for a failed send", () => {
    const { q, cb, show } = mount();
    show({ comments: sev(1), retry: true, resultsLine: "No response." });
    q<HTMLButtonElement>(".comments-rail-retry").click();
    expect(cb.onRetry).toHaveBeenCalled();
  });

  it("cluster chip is removable", () => {
    const { q, cb, show } = mount();
    show({ comments: sev(3), clusterIds: [idOf(1), idOf(2)] });
    expect(q(".comments-rail-cluster-chip").textContent).toContain("2 comments at this spot");
    q<HTMLButtonElement>(".comments-rail-cluster-clear").click();
    expect(cb.onClearCluster).toHaveBeenCalled();
  });
});

describe("CommentsRail chunked rendering (T7)", () => {
  it("renders 50 rows at a time", () => {
    const { qa, q, show } = mount();
    show({ comments: sev(120) });
    expect(qa(".comments-rail-row")).toHaveLength(50);
    q<HTMLButtonElement>(".comments-rail-more").click();
    expect(qa(".comments-rail-row")).toHaveLength(100);
    q<HTMLButtonElement>(".comments-rail-more").click();
    expect(qa(".comments-rail-row")).toHaveLength(120);
    expect(q(".comments-rail-more")).toBeNull();
  });

  it("200 comments render in 4 chunks and a filter change resets to the first chunk", () => {
    const { qa, q, rail, show } = mount();
    show({ comments: sev(200) });
    q<HTMLButtonElement>(".comments-rail-more").click();
    expect(qa(".comments-rail-row")).toHaveLength(100);
    rail.render(buildRailView(input({ comments: sev(200), filter: "open" })));
    expect(qa(".comments-rail-row")).toHaveLength(50);
  });

  it("focusRow extends the rendered chunk to reach a later row", () => {
    const { rail, qa, show } = mount();
    show({ comments: sev(120) });
    expect(rail.focusRow(idOf(110))).toBe(true);
    expect(qa(".comments-rail-row").length).toBeGreaterThanOrEqual(110);
  });
});

describe("CommentsRail keyboard and focus (3.7)", () => {
  it("focusHeading focuses the heading", () => {
    const { rail, q, doc, show } = mount();
    show({ comments: sev(2) });
    rail.focusHeading();
    expect(doc.activeElement).toBe(q("h2"));
  });

  it("Up and Down move between rows with a roving tab stop", () => {
    const { qa, press, doc, show } = mount();
    show({ comments: sev(3) });
    const rows = qa(".comments-rail-row");
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    rows[0]!.focus();
    press(rows[0]!, "ArrowDown");
    expect(doc.activeElement).toBe(rows[1]);
    expect(qa(".comments-rail-row").map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    press(rows[1]!, "ArrowUp");
    expect(doc.activeElement).toBe(rows[0]);
    press(rows[0]!, "End");
    expect(doc.activeElement).toBe(rows[2]);
  });

  it("arrow keys inside a row's buttons do not move rows", () => {
    const { qa, press, doc, show } = mount();
    show({ comments: sev(2) });
    const button = qa<HTMLButtonElement>(".comments-rail-action")[0]!;
    button.focus();
    press(button, "ArrowDown");
    expect(doc.activeElement).toBe(button);
  });

  it("Esc clears a cluster filter first, else closes", () => {
    const { rail, cb, press, show } = mount();
    show({ comments: sev(3), clusterIds: [idOf(1)] });
    press(rail.el, "Escape");
    expect(cb.onClearCluster).toHaveBeenCalledTimes(1);
    expect(cb.onClose).not.toHaveBeenCalled();
    show({ comments: sev(3) });
    press(rail.el, "Escape");
    expect(cb.onClose).toHaveBeenCalledTimes(1);
  });

  it("after the focused row leaves the list, focus goes to the next row, else the previous, else the list", () => {
    const { rail, qa, q, doc, show } = mount();
    show({ comments: sev(3) });
    qa(".comments-rail-row")[1]!.focus();
    rail.render(buildRailView(input({ comments: [comment(1), comment(3)] })));
    expect((doc.activeElement as HTMLElement).dataset.id).toBe(idOf(3));
    qa(".comments-rail-row")[1]!.focus();
    rail.render(buildRailView(input({ comments: [comment(1)] })));
    expect((doc.activeElement as HTMLElement).dataset.id).toBe(idOf(1));
    qa(".comments-rail-row")[0]!.focus();
    rail.render(buildRailView(input({ comments: [] })));
    expect(doc.activeElement).toBe(q(".comments-rail-list"));
  });

  it("does not steal focus when focus was elsewhere", () => {
    const { rail, doc, show } = mount();
    const outside = doc.createElement("button");
    doc.body.append(outside);
    show({ comments: sev(3) });
    outside.focus();
    rail.render(buildRailView(input({ comments: [comment(1)] })));
    expect(doc.activeElement).toBe(outside);
  });
});

describe("CommentsRail narrow mode and motion", () => {
  it("setNarrow toggles the sheet layout class", () => {
    const { rail } = mount();
    rail.setNarrow(true);
    expect(rail.el.classList.contains("is-sheet")).toBe(true);
    rail.setNarrow(false);
    expect(rail.el.classList.contains("is-sheet")).toBe(false);
  });

  it("styles disable motion under prefers-reduced-motion", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "..", "..", "styles", "app.css"), "utf8");
    const block = css.slice(css.indexOf("pins-rail-reduced-motion"));
    expect(block).toMatch(/prefers-reduced-motion: reduce/);
    expect(block.slice(0, 600)).toMatch(/\.pin-badge/);
    expect(block.slice(0, 600)).toMatch(/\.comments-rail/);
    expect(block.slice(0, 600)).toMatch(/transition: none/);
  });
});

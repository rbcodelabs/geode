import { afterEach, expect, it, vi } from "vitest";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
class Element {
  className = ""; textContent = ""; children: Element[] = [];
  set innerHTML(_: string) { this.children = []; }
  appendChild(child: Element) { this.children.push(child); return child; }
  text(): string { return this.textContent + this.children.map(child => child.text()).join(" "); }
  remove() {}
}
afterEach(() => vi.unstubAllGlobals());
function setup() {
  vi.stubGlobal("document", { createElement: () => new Element() });
  const value = Object.create(MarkdownView.prototype) as any;
  const readingEl = new Element(); const file = { path: "Note.md" }; const renderer = { dispose: vi.fn(), render: vi.fn(async () => {}) };
  Object.assign(value, { transitionTail: Promise.resolve(), transitionGeneration: 0, transitionClosing: false, readingRenderGeneration: 0, readingEl, readingContentEl: null, editor: {}, file, mode: "reading", app: { vault: { root: "vault" }, metadataCache: { getFileCache: () => ({ frontmatter: { status: "stale" } }) }, markdownRenderer: renderer }, pagePreview: { hide() {} }, flush: vi.fn(async () => {}), getText: () => "---\nstatus: fresh\n---\nBody", ownLeaf: () => null });
  return { value, readingEl, renderer };
}
it("renders Reading properties from the current buffer despite a stale metadata index", async () => {
  const { value, readingEl, renderer } = setup(); await value.renderReading();
  expect(readingEl.text()).toContain("fresh"); expect(readingEl.text()).not.toContain("stale");
  expect(renderer.render.mock.calls[0]?.[0]).toContain("status: fresh");
});
it("abandons a Reading render if the note changes while flush is pending", async () => {
  const { value, readingEl, renderer } = setup(); let finish!: () => void;
  value.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const pending = value.renderReading(); await new Promise(resolve => setImmediate(resolve)); value.file = { path: "Other.md" }; finish(); await expect(pending).rejects.toThrow(/owner changed/);
  expect(readingEl.children).toHaveLength(0); expect(renderer.render).not.toHaveBeenCalled();
});
it("abandons a Reading render after the vault identity changes", async () => {
  const { value, readingEl, renderer } = setup(); let finish!: () => void;
  value.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const pending = value.renderReading(); await new Promise(resolve => setImmediate(resolve)); value.app.vault.root = "other-vault"; finish(); await expect(pending).rejects.toThrow(/owner changed/);
  expect(readingEl.children).toHaveLength(0); expect(renderer.render).not.toHaveBeenCalled();
});
it("coalesces overlapping Reading refreshes into one guarded current-buffer render", async () => {
  const { value, readingEl, renderer } = setup(); const finishes: (() => void)[] = [];
  value.flush = () => new Promise<void>(resolve => { finishes.push(resolve); });
  const first = value.renderReading(); const second = value.renderReading(); expect(second).toBe(first);
  await new Promise(resolve => setImmediate(resolve)); expect(finishes).toHaveLength(1); finishes[0](); await Promise.all([first, second]);
  expect(renderer.render).toHaveBeenCalledOnce(); expect(readingEl.children).toHaveLength(1);
});

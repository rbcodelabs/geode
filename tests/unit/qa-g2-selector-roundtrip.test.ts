import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import { isRestrictedSelector } from "../../src/artifacts/anchor-selector";
import { boot, type GuestHarness } from "../helpers/inspector-guest-harness";
import { ANCHORS_ARTIFACT, CHART_ARTIFACT, BASIC_ARTIFACT, RESPONSIVE_ARTIFACT, HOSTILE_ARTIFACT } from "../e2e/helpers/artifact-picker-fixtures";

vi.setConfig({ testTimeout: 120_000 });

/**
 * QA (G2, independent): can a legitimate selector that the picker ITSELF generates be rejected by the guest's selector
 * grammar? The picker (artifact-inspector-guest.ts, buildSelectors) and the grammar (anchor-selector.ts) are written
 * separately; this drives the real generator over many pages (select every element), runs every emitted selector and
 * alternate through `isRestrictedSelector`, and then feeds the selection back through the real tracker to prove the
 * element is found again by the selector (not by a fallback).
 */

const MODE_PICK = { mode: "pick", redactText: false };
interface Picked { el: Element; selector: string; alternates: string[]; tag: string; route: string; textAnchor: { tag: string; text: string }; landmark: string | null }

function selectAll(html: string, limit = 400): { h: GuestHarness; picked: Picked[] } {
  const h = boot(html);
  const all = [...h.doc.body.querySelectorAll("*")].slice(0, limit);
  const picked: Picked[] = [];
  for (const el of all) {
    h.deliver(INSPECT_CHANNEL.mode, MODE_PICK);
    h.pointAt(el);
    h.sent.length = 0;
    h.fire("click", { clientX: 10, clientY: 10, button: 0 }, el);
    h.flush(3);
    const msg = h.last(INSPECT_CHANNEL.select)?.payload;
    if (!msg) continue;
    picked.push({ el, selector: msg.selector, alternates: msg.selectorAlternates, tag: msg.tag, route: msg.route, textAnchor: msg.textAnchor, landmark: msg.landmark });
  }
  return { h, picked };
}

const candidates = (p: Picked): string[] => [p.selector, ...p.alternates].filter((s) => s !== "");

function offenders(picked: Picked[]): string[] {
  const bad: string[] = [];
  for (const p of picked) for (const s of candidates(p)) if (!isRestrictedSelector(s)) bad.push(`<${p.el.localName}> ${s.length > 160 ? s.slice(0, 160) + "..." : s}`);
  return bad;
}

/** A report-shaped page: headings, variations, tables, lists, legends, repeated cards, ids that need escaping. */
function reportPage(): string {
  const rows = Array.from({ length: 40 }, (_, i) => `<tr><td>Row ${i}</td><td class="num">${i * 3}</td></tr>`).join("");
  const cards = Array.from({ length: 12 }, (_, i) => `<article class="card kpi"><h3>KPI ${i}</h3><p class="value">${i * 7}%</p><span class="delta up">+${i}</span></article>`).join("");
  const legend = ["Alpha", "Beta", "Gamma"].map((s, i) => `<li class="legend-item"><span class="swatch" style="background:#${i}${i}${i}"></span>${s}</li>`).join("");
  return `<!doctype html><html><body><main id="report">
  <h1>Quarterly report</h1>
  <section data-variation="A" class="variation"><h2>Variation A</h2>${cards}</section>
  <section data-variation="B" class="variation"><h2>Variation B</h2>${cards}</section>
  <section id="2024-q4"><h2 id="-1">Table</h2><table id="t.1"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></section>
  <ul class="legend" id="a:b">${legend}</ul>
  <svg viewBox="0 0 100 100" width="100" height="100"><g id="plot"><rect x="1" y="1" width="9" height="9"/><rect x="11" y="1" width="9" height="9"/><linearGradient id="g1"><stop offset="0"/></linearGradient><foreignObject x="0" y="0" width="5" height="5"><div>fo</div></foreignObject></g></svg>
  </main></body></html>`;
}

/** Awkward but legal names for ids, classes, testids. */
function weirdPage(): string {
  const longTestId = (n: number) => "t".repeat(n);
  return `<!doctype html><html><body>
  <div id="1abc" class="1st">digit-leading id and class</div>
  <div id="-1" class="-2x">dash digit</div>
  <div id="--x" class="--y">double dash</div>
  <div id="-" class="-">lone dash</div>
  <div id="a:b" class="a:b">colon</div>
  <div id="a.b" class="w-1/2 hover:bg-red md:w-[50%] !p-4">tailwindish</div>
  <div id="é" class="ñandú café">unicode</div>
  <div id="😀" class="😀">emoji</div>
  <div id="a b" class="a_b">space in id</div>
  <div id="a&quot;b" class="q">quote in id</div>
  <div id="a\\b" class="b">backslash in id</div>
  <p data-testid="has &quot;quote&quot;">quote testid</p>
  <p data-testid="back\\slash">backslash testid</p>
  <p data-testid="unicode-é-😀">unicode testid</p>
  <p data-testid="bracket]">bracket testid</p>
  <p data-testid="a b">space testid</p>
  <p data-testid="${longTestId(119)}">testid 119</p>
  <p data-testid="${longTestId(120)}">testid 120</p>
  <p data-testid="${longTestId(121)}">testid 121</p>
  <p data-testid="${longTestId(128)}">testid 128</p>
  <p data-testid="${longTestId(129)}">testid 129 (generator skips)</p>
  <div id="1"><section><b>escaped-id child</b></section></div>
  <ol><li>one</li><li>two</li><li>three</li><li>four</li></ol>
  <ul><li class="x">a</li><li class="x">b</li><li class="x">c</li></ul>
  <svg width="10" height="10"><clipPath id="cp"><rect width="1" height="1"/></clipPath><linearGradient id="lg"><stop/></linearGradient><foreignObject id="fo" width="5" height="5"><div id="inner">x</div></foreignObject></svg>
  </body></html>`;
}

function deepPage(depth: number): string {
  return `<!doctype html><html><body>${"<div>".repeat(depth)}<span>leaf</span>${"</div>".repeat(depth)}</body></html>`;
}

const PAGES: Array<[string, () => string]> = [
  ["picker-basic fixture", () => BASIC_ARTIFACT.html],
  ["picker-responsive fixture", () => RESPONSIVE_ARTIFACT.html],
  ["picker-hostile fixture (static part)", () => HOSTILE_ARTIFACT.html],
  ["picker-chart fixture (report-like SVG chart, camelCase elements)", () => CHART_ARTIFACT.html],
  ["picker-anchors fixture (static part)", () => ANCHORS_ARTIFACT.html],
  ["report-shaped page (cards, tables, legend, variations)", reportPage],
  ["awkward ids, classes and testids", weirdPage],
  ["deep nesting (30 levels, no ids)", () => deepPage(30)],
  ["deep nesting (12 levels, no ids)", () => deepPage(12)],
  ["deep nesting (11 levels, no ids)", () => deepPage(11)],
];

describe("QA G2: every selector the picker generates is accepted by the guest grammar", () => {
  it.each(PAGES)("%s", (_name, html) => {
    const { picked } = selectAll(html());
    expect(picked.length).toBeGreaterThan(0);
    // Every candidate the generator verified as unique must be inside the subset the tracker will execute.
    expect(offenders(picked.filter((p) => !(p.el.getAttribute("data-testid") ?? "").match(/^t{121,128}$/)))).toEqual([]);
  });

  // DEFECT QA-G2-1 (Medium-Low): the generator emits [data-testid="..."] for values up to 128 chars, the grammar caps a value at
  // 120 units, so a legitimate primary selector for a testid of 121..128 chars is rejected (it falls to alternates/text).
  // Remove `.fails` when the caps agree.
  it.fails("a data-testid of 121 to 128 characters (the generator allows 128) is accepted (the grammar value cap is 120)", () => {
    const { picked } = selectAll(weirdPage());
    const long = picked.filter((p) => /^t{121,128}$/.test(p.el.getAttribute("data-testid") ?? ""));
    expect(long.length).toBe(2);
    for (const p of long) expect(isRestrictedSelector(p.selector), `${p.selector.slice(0, 40)}... (${p.selector.length} chars)`).toBe(true);
  });

  it("the boundaries: testid of 119 and 120 chars are accepted; 129 is not generated at all", () => {
    const { picked } = selectAll(weirdPage());
    for (const n of [119, 120]) {
      const p = picked.find((x) => x.el.getAttribute("data-testid") === "t".repeat(n))!;
      expect(p.selector.startsWith("[data-testid=")).toBe(true);
      expect(isRestrictedSelector(p.selector)).toBe(true);
    }
    const p129 = picked.find((x) => x.el.getAttribute("data-testid") === "t".repeat(129))!;
    expect(p129.selector.startsWith("[data-testid=")).toBe(false);
  });

  it("an attribute value of 120 chars, every one escaped by the generator (quotes and backslashes), is accepted", () => {
    const value = '"\\'.repeat(60); // 120 chars, each costs one unit in the grammar although it is two characters in the selector
    const html = `<body><p id="x" data-testid="${value.replace(/"/g, "&quot;")}">e</p></body>`;
    const { picked } = selectAll(html);
    const p = picked.find((x) => x.el.id === "x")!;
    expect(p.selector.startsWith("[data-testid=")).toBe(true);
    expect(isRestrictedSelector(p.selector)).toBe(true);
  });

  // DEFECT QA-G2-2 (Low): the class candidate writes the raw localName (selectorTag) but the grammar's tag is ASCII letters, digits
  // and "-" only, so `my_el.c` and `x-föö.u1` (elements the parser accepts; the anchor tag is sanitized to my-el / x-f--) are
  // rejected and the anchor degrades to the text step ("moved") instead of an exact selector hit.
  it.fails("a custom element with a non-ASCII or underscore name still gets a selector the grammar accepts", () => {
    const html = `<body><x-föö class="u1">1</x-föö><x-föö class="a b">2</x-föö><my_el class="c">3</my_el><a-b.c class="d">4</a-b.c></body>`;
    const { picked } = selectAll(html);
    expect(picked.length).toBe(4);
    expect(offenders(picked)).toEqual([]);
  });
});

describe("QA G2: the tracker finds every generated selection again through the SELECTOR step (not a fallback)", () => {
  it.each(PAGES.filter(([n]) => !n.startsWith("deep")))("%s", (_name, html) => {
    const { h, picked } = selectAll(html());
    // Rects: give each element its own distinct rect so a wrong element would show.
    picked.forEach((p, i) => h.setRect(p.el, { x: i, y: 2 * i, width: 10 + i, height: 5 }));
    // Selections whose primary selector the grammar rejects are the subject of the it.fails cases above; skip them here.
    const usable = picked.filter((p) => p.selector !== "" && isRestrictedSelector(p.selector)).slice(0, 100);
    const queries: InspectAnchorQuery[] = usable.map((p, i) => ({
      key: `a${i}`, route: p.route, tag: p.tag, selector: p.selector, alternates: p.alternates, textAnchor: p.textAnchor, landmark: p.landmark,
    }));
    h.sent.length = 0;
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 1, redactText: false, anchors: queries });
    for (let i = 0; i < 80; i++) { h.flush(1); h.advance(5); }
    const res = h.last(INSPECT_CHANNEL.anchorResults)?.payload as { results: Array<{ key: string; match: string; agrees: boolean; rect: { x: number } | null }> };
    expect(res.results.length).toBe(queries.length);
    const notSelector = res.results.filter((r) => r.match !== "selector" || !r.agrees).map((r) => `${r.key}:${r.match}/${r.agrees} ${queries[Number(r.key.slice(1))]!.selector.slice(0, 80)}`);
    expect(notSelector).toEqual([]);
    usable.forEach((p, i) => {
      const r = res.results.find((x) => x.key === `a${i}`)!;
      expect(r.rect?.x, `rect of <${p.el.localName}> ${p.selector.slice(0, 60)}`).toBe(picked.indexOf(p));
    });
  });

  it("units note: the cap used by the grammar and the generator are what this test assumes", () => {
    expect(INSPECTOR_CAPS.anchorAttributeValueUnits).toBe(120);
    expect(INSPECTOR_CAPS.selectorUnits).toBe(512);
    expect(INSPECTOR_CAPS.anchorSelectorCompounds).toBe(12);
  });
});

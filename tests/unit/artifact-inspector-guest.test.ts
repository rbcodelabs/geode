import { describe, expect, it, vi } from "vitest";
import {
  INSPECT_CHANNEL,
  INSPECTOR_CAPS,
  INSPECTOR_STYLE_ALLOWLIST,
  OUTER_HTML_TRUNCATION_MARKER,
} from "../../src/artifacts/inspector-protocol";
import { startInspector } from "../../src/main/artifact-inspector-guest";
import { boot, trusted, type GuestHarness } from "../helpers/inspector-guest-harness";

const PAGE = `<body>
  <main>
    <h2>Pricing</h2>
    <section class="plans" data-variation="B">
      <div class="card pro" id="pro"><button class="cta primary" aria-label="Buy now" data-testid="buy">Buy</button></div>
      <div class="card"><span>Free</span></div>
    </section>
  </main>
</body>`;

const modePick = { mode: "pick", redactText: false };
function pick(html = PAGE, options?: Parameters<typeof boot>[1]) {
  const h = boot(html, options);
  h.deliver(INSPECT_CHANNEL.mode, modePick);
  return h;
}
const $ = (h: GuestHarness, selector: string) => h.doc.querySelector(selector)!;
function clickOn(h: GuestHarness, el: Element, init: Record<string, unknown> = {}) {
  h.pointAt(el);
  return h.fire("click", { clientX: 10, clientY: 10, button: 0, ...init }, el);
}
function selectOn(h: GuestHarness, el: Element) {
  clickOn(h, el);
  h.flush(3);
  return h.last(INSPECT_CHANNEL.select)?.payload;
}

describe("start and handshake", () => {
  it("sends ready with the protocol at document start, exposes nothing, and does nothing in a sub-frame", () => {
    const h = boot(PAGE, { start: false });
    const before = new Set(Object.getOwnPropertyNames(h.win));
    h.start();
    expect(h.sent).toEqual([{ channel: INSPECT_CHANNEL.ready, payload: { protocol: 1 } }]);
    expect([...Object.getOwnPropertyNames(h.win)].filter((k) => !before.has(k))).toEqual([]);

    const frameHost = boot(PAGE, { start: false });
    const iframe = frameHost.doc.createElement("iframe");
    frameHost.doc.body.appendChild(iframe);
    const sent: unknown[] = [];
    const result = startInspector({ window: iframe.contentWindow as never, ipc: { send: (c, p) => sent.push([c, p]), on: () => {} } });
    expect(result).toBeNull();
    expect(sent).toEqual([]);
  });

  it("sends ready again for every new document and honours the re-sent mode", () => {
    for (let reload = 0; reload < 2; reload++) {
      const h = boot(PAGE);
      expect(h.all(INSPECT_CHANNEL.ready)).toHaveLength(1);
      h.deliver(INSPECT_CHANNEL.mode, modePick);
      expect(h.guest!.mode).toBe("pick");
    }
  });

  it("ignores malformed mode messages", () => {
    const h = boot(PAGE);
    for (const bad of [null, undefined, "pick", 3, { mode: "bogus", redactText: false }, { mode: "pick" }, { mode: "pick", redactText: "yes" }, { redactText: true }]) {
      h.deliver(INSPECT_CHANNEL.mode, bad);
      expect(h.guest!.mode).toBe("off");
    }
  });
});

describe("trust and mode gating", () => {
  it("ignores untrusted events entirely: the page keeps them and nothing is sent", () => {
    const h = pick();
    const btn = $(h, "button");
    const pageSaw: string[] = [];
    h.win.addEventListener("click", () => pageSaw.push("window"), true);
    btn.addEventListener("click", () => pageSaw.push("target"));
    h.pointAt(btn);
    const synthetic = new h.win.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 3, clientY: 3 });
    expect(synthetic.isTrusted).toBe(false);
    btn.dispatchEvent(synthetic);
    h.flush(3);
    expect(pageSaw).toEqual(["window", "target"]);
    expect(synthetic.defaultPrevented).toBe(false);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(0);
    btn.dispatchEvent(new h.win.MouseEvent("mousemove", { bubbles: true }));
    h.flush();
    expect(h.all(INSPECT_CHANNEL.hover)).toHaveLength(0);
  });

  it("off: trusted events reach the page untouched", () => {
    const h = boot(PAGE);
    const btn = $(h, "button");
    const seen: string[] = [];
    btn.addEventListener("click", () => seen.push("click"));
    const ev = h.fire("click", {}, btn);
    expect(seen).toEqual(["click"]);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("pick: the page sees none of the pointer family, the click selects", () => {
    const h = pick();
    const btn = $(h, "button");
    const seen: string[] = [];
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"]) {
      btn.addEventListener(type, () => seen.push(type));
      h.win.addEventListener(type, () => seen.push(`w:${type}`)); // bubble-phase page listener
    }
    h.pointAt(btn);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu"]) {
      const ev = h.fire(type, { clientX: 1, clientY: 1 }, btn);
      expect(ev.defaultPrevented).toBe(true);
    }
    const click = h.fire("click", { clientX: 1, clientY: 1, button: 0 }, btn);
    expect(click.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(1);
  });

  it("a page listener registered on window in the capture phase after the preload cannot see the click", () => {
    const h = pick();
    const seen: string[] = [];
    h.win.addEventListener("click", () => seen.push("page"), true);
    clickOn(h, $(h, "button"));
    expect(seen).toEqual([]);
  });

  it("hold: swallows pointer events and keys, never highlights or selects", () => {
    const h = pick();
    h.deliver(INSPECT_CHANNEL.mode, { mode: "hold", redactText: false });
    expect(h.shadowRoots.filter((s) => s.host.isConnected)).toHaveLength(0);
    const seen: string[] = [];
    h.win.addEventListener("keydown", () => seen.push("key"));
    const ev = clickOn(h, $(h, "button"));
    expect(ev.defaultPrevented).toBe(true);
    for (const key of ["[", "]", "Enter"]) expect(h.fire("keydown", { key }).defaultPrevented).toBe(true);
    expect(h.fire("keydown", { key: "a" }).defaultPrevented).toBe(false);
    h.flush(3);
    expect(seen).toEqual(["key"]);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(0);
    expect(h.all(INSPECT_CHANNEL.hover)).toHaveLength(0);
  });

  it("returning to off releases the page and removes the highlight host", () => {
    const h = pick();
    h.pointAt($(h, "button"));
    h.fire("mousemove", { clientX: 1, clientY: 1 });
    h.flush();
    expect(h.shadowRoots.some((s) => s.host.isConnected)).toBe(true);
    h.deliver(INSPECT_CHANNEL.mode, { mode: "off", redactText: false });
    expect(h.shadowRoots.some((s) => s.host.isConnected)).toBe(false);
    const seen: string[] = [];
    $(h, "button").addEventListener("click", () => seen.push("click"));
    h.fire("click", {}, $(h, "button"));
    expect(seen).toEqual(["click"]);
  });
});

describe("hover", () => {
  it("sends only tag, rect and via, one message per frame", () => {
    const h = pick();
    const btn = $(h, "button");
    h.setRect(btn, { x: 11, y: 22, width: 33, height: 44 });
    h.pointAt(btn);
    h.fire("mousemove", { clientX: 12, clientY: 23 });
    h.fire("mousemove", { clientX: 13, clientY: 24 });
    expect(h.all(INSPECT_CHANNEL.hover)).toHaveLength(0);
    h.flush();
    const hovers = h.all(INSPECT_CHANNEL.hover);
    expect(hovers).toHaveLength(1);
    expect(hovers[0]!.payload).toEqual({ tag: "button", rect: { x: 11, y: 22, width: 33, height: 44 }, via: "pointer" });
    expect(Object.keys(hovers[0]!.payload).sort()).toEqual(["rect", "tag", "via"]);
  });

  it("does not repeat an identical hover and never computes selection data", () => {
    const h = pick();
    const btn = $(h, "button");
    const spy = vi.spyOn(h.doc, "querySelectorAll");
    h.pointAt(btn);
    for (let i = 0; i < 3; i++) { h.fire("mousemove", { clientX: 1, clientY: 1 }); h.flush(); }
    expect(h.all(INSPECT_CHANNEL.hover)).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores the highlight host itself", () => {
    const h = pick();
    h.pointAt($(h, "button"));
    h.fire("mousemove", {});
    h.flush();
    h.pointAt(h.shadowRoots[0]!.host);
    h.fire("mousemove", {});
    h.flush();
    expect(h.all(INSPECT_CHANNEL.hover)).toHaveLength(1);
  });

  it("draws the highlight in a closed shadow root with adoptedStyleSheets only", () => {
    const h = pick();
    const btn = $(h, "button");
    h.setRect(btn, { x: 5, y: 6, width: 7, height: 8 });
    h.pointAt(btn);
    h.fire("mousemove", {});
    h.flush();
    const { host, root } = h.shadowRoots[0]!;
    expect(host.isConnected).toBe(true);
    expect(host.parentElement).toBe(h.doc.documentElement);
    expect(host.shadowRoot).toBeNull(); // closed
    expect((root as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets.length).toBe(1);
    expect(h.sheets.join("\n")).toMatch(/left:\s*5px/);
    expect(h.doc.querySelectorAll("style").length).toBe(0);
    expect(root.querySelectorAll("style").length).toBe(0);
    expect(host.hasAttribute("style")).toBe(false);
    expect(root.querySelector("[style]")).toBeNull();
  });
});

describe("select", () => {
  it("waits two frames, hides the highlight, then sends the full selection and holds", () => {
    const h = pick();
    const btn = $(h, "button");
    h.setRect(btn, { x: 20, y: 30, width: 100, height: 40 });
    h.pointAt(btn);
    h.fire("mousemove", {});
    h.flush();
    expect(h.shadowRoots.some((s) => s.host.isConnected)).toBe(true);
    clickOn(h, btn);
    expect(h.shadowRoots.some((s) => s.host.isConnected)).toBe(false);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(0);
    h.flush();
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(0);
    h.flush();
    const select = h.all(INSPECT_CHANNEL.select);
    expect(select).toHaveLength(1);
    const msg = select[0]!.payload;
    expect(Object.keys(msg).sort()).toEqual(
      ["a11y", "ancestors", "boundingBox", "computedStyles", "landmark", "outerHTML", "route", "selector", "selectorAlternates", "tag", "textAnchor", "viewport"].sort());
    expect(msg.tag).toBe("button");
    expect(msg.route).toBe("/page.html#frag");
    expect(msg.boundingBox).toEqual({ viewport: { x: 20, y: 30, width: 100, height: 40 } });
    expect(msg.textAnchor).toEqual({ tag: "button", text: "Buy" });
    expect(msg.landmark).toBe("B"); // nearest data-variation ancestor wins over the heading
    expect(msg.ancestors.map((a: { tag: string }) => a.tag)).toEqual(["div", "section", "main"]);
    expect(msg.ancestors[0]).toEqual({ tag: "div", id: "pro", classes: ["card", "pro"] });
    expect(msg.a11y).toEqual({ role: "button", name: "Buy now", tabIndex: 0 });
    expect(msg.viewport).toMatchObject({ width: expect.any(Number), height: expect.any(Number), devicePixelRatio: expect.any(Number), scrollX: 0, scrollY: 0 });
    expect(h.guest!.mode).toBe("hold");
    // a second click cannot slip through before the embedder answers
    clickOn(h, btn);
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(1);
    // ...until the next mode message
    h.deliver(INSPECT_CHANNEL.mode, modePick);
    clickOn(h, btn);
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(2);
  });

  it("only a primary-button click selects; other buttons are swallowed", () => {
    const h = pick();
    const ev = clickOn(h, $(h, "button"), { button: 1 });
    expect(ev.defaultPrevented).toBe(true);
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(0);
  });

  it("does not send, and returns to pick, if the element vanished while waiting", () => {
    const h = pick();
    const btn = $(h, "button");
    clickOn(h, btn);
    btn.remove();
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(0);
    expect(h.guest!.mode).toBe("pick");
  });

  it("builds a unique primary selector and verified distinct alternates", () => {
    const h = pick();
    const msg = selectOn(h, $(h, "button"));
    const all = [msg.selector, ...msg.selectorAlternates] as string[];
    expect(msg.selector.length).toBeLessThanOrEqual(512);
    expect(msg.selectorAlternates.length).toBeLessThanOrEqual(3);
    expect(new Set(all).size).toBe(all.length);
    for (const selector of all) {
      expect(h.doc.querySelectorAll(selector).length).toBe(1);
      expect(h.doc.querySelector(selector)).toBe($(h, "button"));
    }
    expect(msg.selector).toBe('[data-testid="buy"]');
  });

  it.each([
    ["duplicate ids fall back to structure", `<body><div id="a"><p>x</p></div><div id="a"><p>y</p></div></body>`, "div:nth-of-type(2) p"],
    ["identical siblings use nth-of-type", `<body><ul><li>1</li><li>2</li><li>3</li></ul></body>`, "li:nth-of-type(3)"],
    ["an id with special characters is escaped", `<body><div id="a.b:c d"><i>t</i></div></body>`, "div"],
  ])("selector uniqueness: %s", (_name, html, target) => {
    const h = pick(html);
    const els = [...h.doc.querySelectorAll(target.startsWith("div:nth") ? "#a p" : target.startsWith("li") ? "li" : "div")];
    const el = target.startsWith("div:nth") ? els[1]! : target.startsWith("li") ? els[2]! : els[0]!;
    const msg = selectOn(h, el);
    expect(h.doc.querySelector(msg.selector)).toBe(el);
    expect(h.doc.querySelectorAll(msg.selector).length).toBe(1);
    for (const alt of msg.selectorAlternates) expect(h.doc.querySelector(alt)).toBe(el);
  });

  it("falls back to the heading landmark and truncates long text anchors", () => {
    const h = pick(`<body><h1>Welcome home</h1><div class="x">${"word ".repeat(100)}</div></body>`);
    const msg = selectOn(h, $(h, ".x"));
    expect(msg.landmark).toBe("Welcome home");
    expect(msg.textAnchor.text.length).toBeLessThanOrEqual(80);
    expect(msg.textAnchor.text.startsWith("word word")).toBe(true);
  });

  it("clamps route and landmark length and keeps ancestors at three", () => {
    const h = pick(`<body><h2>${"L".repeat(500)}</h2><div><div><div><div><div><p id="t">x</p></div></div></div></div></div></body>`, { url: "https://a.test/" + "p".repeat(900) + "#h" });
    const msg = selectOn(h, $(h, "#t"));
    expect(msg.route.length).toBeLessThanOrEqual(INSPECTOR_CAPS.routeUnits);
    expect(msg.landmark.length).toBeLessThanOrEqual(INSPECTOR_CAPS.landmarkUnits);
    expect(msg.ancestors).toHaveLength(3);
  });
});

describe("outerHTML sanitization", () => {
  const html = (inner: string) => `<body><div id="x">${inner}</div></body>`;

  it("strips script bodies and comments, elides data: URIs, srcdoc and handlers, and escapes text", () => {
    const h = pick(html(`<script>alert(1)</script><!-- secret --><img src="data:image/png;base64,AAAA"><iframe srcdoc="<b>boo</b>"></iframe><a href="/ok" onclick="evil()" title="${"t".repeat(300)}">hi &lt;b&gt; <b>bold</b></a>`));
    const out = selectOn(h, $(h, "#x")).outerHTML;
    expect(out.html).not.toContain("alert(1)");
    expect(out.html).not.toContain("secret");
    expect(out.html).not.toContain("AAAA");
    expect(out.html).not.toContain("boo");
    expect(out.html).not.toContain("evil()");
    expect(out.html).toContain("data:...elided");
    expect(out.html).toContain('srcdoc="..."');
    expect(out.html).toContain('href="/ok"');
    expect(out.html).toContain("&lt;b&gt;");
    expect(out.html).toContain("<script></script>");
    expect(out.html).not.toMatch(/t{201}/);
    expect(out.truncated).toBe(false);
    expect(out.html.startsWith('<div id="x">')).toBe(true);
  });

  it("truncates at 4096 including a marker", () => {
    const h = pick(html(`<p>${"x ".repeat(5000)}</p>`));
    const out = selectOn(h, $(h, "#x")).outerHTML;
    expect(out.truncated).toBe(true);
    expect(out.html.length).toBeLessThanOrEqual(4096);
    expect(out.html.endsWith(OUTER_HTML_TRUNCATION_MARKER)).toBe(true);
  });

  it("does not serialize a 50k-node subtree: bounded visits and time", () => {
    const h = boot(`<body><div id="big"></div></body>`, { start: false });
    const big = $(h, "#big");
    const frag = h.doc.createDocumentFragment();
    for (let i = 0; i < 50_000; i++) { const d = h.doc.createElement("div"); d.className = "n" + (i % 7); d.textContent = "n" + i; frag.appendChild(d); }
    big.appendChild(frag);
    let visits = 0;
    const desc = Object.getOwnPropertyDescriptor(h.win.Node.prototype, "nextSibling")!;
    Object.defineProperty(h.win.Node.prototype, "nextSibling", { get() { visits++; return desc.get!.call(this); } });
    h.start();
    h.deliver(INSPECT_CHANNEL.mode, modePick);
    const started = Date.now();
    const msg = selectOn(h, big);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(msg.outerHTML.truncated).toBe(true);
    expect(msg.outerHTML.html.length).toBeLessThanOrEqual(4096);
    expect(visits).toBeLessThan(5000);
  });

  it("survives absurd nesting without recursion", () => {
    let nested = "<i>leaf</i>";
    for (let i = 0; i < 4000; i++) nested = `<span>${nested}</span>`;
    const h = boot(`<body></body>`, { start: false });
    h.doc.body.innerHTML = nested;
    h.start();
    h.deliver(INSPECT_CHANNEL.mode, modePick);
    const msg = selectOn(h, h.doc.body.firstElementChild!);
    expect(msg.outerHTML.html.length).toBeLessThanOrEqual(4096);
    expect(msg.outerHTML.truncated).toBe(true);
  });

  it("stops on the time budget", () => {
    let clock = 0;
    const h = boot(html(`<p>a</p><p>b</p><p>c</p>`.repeat(40)), { start: false, env: { now: () => (clock += 10) } });
    h.start();
    h.deliver(INSPECT_CHANNEL.mode, modePick);
    const msg = selectOn(h, $(h, "#x"));
    expect(msg.outerHTML.truncated).toBe(true);
  });
});

describe("computed styles", () => {
  it("reads only the 40 allowlisted properties, elides data: backgrounds and caps values", () => {
    const h = pick();
    const btn = $(h, "button");
    h.setStyle(btn, {
      display: "inline-block", color: "rgb(1, 2, 3)", "font-family": "f".repeat(500),
      "background-image": 'url("data:image/png;base64,AAAA"), url(/x.png)', cursor: "pointer", "--secret": "no",
    });
    const asked: string[] = [];
    const gcs = h.win.getComputedStyle;
    (h.win as { getComputedStyle: unknown }).getComputedStyle = (el: Element) => {
      const real = gcs(el);
      return new Proxy(real, { get(t, p) { if (p === "getPropertyValue") return (n: string) => { asked.push(n); return real.getPropertyValue(n); }; return Reflect.get(t, p); } });
    };
    // natives are captured at start, so this late patch must NOT be what the guest calls
    const msg = selectOn(h, btn);
    expect(INSPECTOR_STYLE_ALLOWLIST).toHaveLength(40);
    expect(asked).toEqual([]);
    expect(Object.keys(msg.computedStyles).every((k) => INSPECTOR_STYLE_ALLOWLIST.includes(k))).toBe(true);
    expect(msg.computedStyles.display).toBe("inline-block");
    expect(msg.computedStyles.cursor).toBeUndefined();
    expect(msg.computedStyles["--secret"]).toBeUndefined();
    expect(msg.computedStyles["font-family"].length).toBeLessThanOrEqual(200);
    expect(msg.computedStyles["background-image"]).toContain("url(data:...elided)");
    expect(msg.computedStyles["background-image"]).not.toContain("AAAA");
  });
});

describe("redactText (vault: read artifacts)", () => {
  it("removes text, non-whitelisted attribute values and accessible names", () => {
    const h = boot(`<body><h2>Secret heading</h2><section data-variation="B"><div id="x" class="c" title="private" data-note="n" role="group">Salary 100k<b>more</b></div></section></body>`);
    h.deliver(INSPECT_CHANNEL.mode, { mode: "pick", redactText: true });
    const msg = selectOn(h, $(h, "#x"));
    expect(msg.textAnchor).toEqual({ tag: "div", text: "" });
    expect(msg.a11y.name).toBeNull();
    expect(msg.outerHTML.html).not.toContain("Salary");
    expect(msg.outerHTML.html).not.toContain("more");
    expect(msg.outerHTML.html).not.toContain("private");
    expect(msg.outerHTML.html).toContain('id="x"');
    expect(msg.outerHTML.html).toContain('class="c"');
    expect(msg.outerHTML.html).toContain('role="group"');
    expect(msg.outerHTML.html).toContain('title="..."');
    expect(msg.outerHTML.html).toContain('data-note="..."');
    expect(msg.landmark).toBe("B"); // data-variation is on the keep list; heading text is not
  });

  it("omits the heading landmark and the keyboard hover label", () => {
    const h = boot(`<body><h2>Secret heading</h2><div id="x">Secret text</div></body>`);
    h.deliver(INSPECT_CHANNEL.mode, { mode: "pick", redactText: true });
    h.pointAt($(h, "#x"));
    h.fire("mousemove", {});
    h.flush();
    h.fire("keydown", { key: "[" });
    const keyboard = h.all(INSPECT_CHANNEL.hover).find((m) => m.payload.via === "keyboard");
    expect(keyboard!.payload.label).toBeUndefined();
    h.deliver(INSPECT_CHANNEL.mode, { mode: "pick", redactText: true });
    expect(selectOn(h, $(h, "#x")).landmark).toBeNull();
  });
});

describe("keyboard", () => {
  function hoverButton() {
    const h = pick();
    const btn = $(h, "button");
    for (const el of h.doc.querySelectorAll("*")) h.setRect(el, { x: 1, y: 2, width: 3, height: 4 });
    h.pointAt(btn);
    h.fire("mousemove", {});
    h.flush();
    return { h, btn };
  }

  it("[ walks to the parent, ] to the first child, with keyboard hover and a label, stopping at body", () => {
    const { h } = hoverButton();
    expect(h.fire("keydown", { key: "[" }).defaultPrevented).toBe(true);
    let last = h.last(INSPECT_CHANNEL.hover)!.payload;
    expect(last).toMatchObject({ tag: "div", via: "keyboard", label: "Buy" });
    expect(Object.keys(last).sort()).toEqual(["label", "rect", "tag", "via"]);
    h.fire("keydown", { key: "]" });
    last = h.last(INSPECT_CHANNEL.hover)!.payload;
    expect(last).toMatchObject({ tag: "button", via: "keyboard", label: "Buy now" });
    for (let i = 0; i < 12; i++) h.fire("keydown", { key: "[" });
    expect(h.last(INSPECT_CHANNEL.hover)!.payload.tag).toBe("body");
    const count = h.all(INSPECT_CHANNEL.hover).length;
    h.fire("keydown", { key: "[" });
    expect(h.all(INSPECT_CHANNEL.hover)).toHaveLength(count); // already at body: no new hover
  });

  it("Enter selects the candidate; Escape cancels; other keys and modified keys reach the page", () => {
    const { h, btn } = hoverButton();
    h.fire("keydown", { key: "[" });
    expect(h.fire("keydown", { key: "a" }).defaultPrevented).toBe(false);
    expect(h.fire("keydown", { key: "[", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(h.fire("keydown", { key: "Enter" }).defaultPrevented).toBe(true);
    h.flush(2);
    expect(h.last(INSPECT_CHANNEL.select)!.payload.tag).toBe("div");
    expect(btn.isConnected).toBe(true);
    h.deliver(INSPECT_CHANNEL.mode, modePick);
    const ev = h.fire("keydown", { key: "Escape" });
    expect(ev.defaultPrevented).toBe(true);
    expect(h.last(INSPECT_CHANNEL.cancel)!.payload).toEqual({ reason: "escape" });
  });

  it("starts from activeElement, then body, when nothing was hovered", () => {
    const h = pick();
    const btn = $(h, "button") as HTMLElement;
    btn.focus();
    h.fire("keydown", { key: "Enter" });
    h.flush(2);
    expect(h.last(INSPECT_CHANNEL.select)!.payload.tag).toBe("button");
    const h2 = pick();
    h2.fire("keydown", { key: "Enter" });
    h2.flush(2);
    expect(h2.last(INSPECT_CHANNEL.select)!.payload.tag).toBe("body");
  });

  it("embedder key messages behave like native keys; junk is ignored", () => {
    const { h } = hoverButton();
    h.deliver(INSPECT_CHANNEL.key, { key: "parent" });
    expect(h.last(INSPECT_CHANNEL.hover)!.payload).toMatchObject({ tag: "div", via: "keyboard" });
    h.deliver(INSPECT_CHANNEL.key, { key: "child" });
    expect(h.last(INSPECT_CHANNEL.hover)!.payload.tag).toBe("button");
    const n = h.all(INSPECT_CHANNEL.hover).length;
    h.deliver(INSPECT_CHANNEL.key, { key: "sibling" });
    h.deliver(INSPECT_CHANNEL.key, null);
    expect(h.all(INSPECT_CHANNEL.hover)).toHaveLength(n);
    h.deliver(INSPECT_CHANNEL.key, { key: "select" });
    h.flush(2);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(1);
  });

  it("the hover label is capped at 80 units", () => {
    const h = pick(`<body><div id="x" aria-label="${"L".repeat(300)}"><i>i</i></div></body>`);
    h.pointAt($(h, "i"));
    h.fire("mousemove", {});
    h.flush();
    h.fire("keydown", { key: "[" });
    expect(h.last(INSPECT_CHANNEL.hover)!.payload.label.length).toBeLessThanOrEqual(80);
  });
});

describe("self-healing", () => {
  function hovered() {
    const h = pick();
    h.pointAt($(h, "button"));
    h.fire("mousemove", {});
    h.flush();
    return h;
  }

  it("re-attaches a removed highlight host, coalesced per frame", async () => {
    const h = hovered();
    const { host } = h.shadowRoots[0]!;
    host.remove();
    await Promise.resolve(); // MutationObserver microtask
    h.flush();
    expect(host.isConnected).toBe(true);
  });

  it("caps re-attachment at 20 per second, then goes degraded until the mode changes", async () => {
    const h = hovered();
    const { host } = h.shadowRoots[0]!;
    let reattached = 0;
    for (let i = 0; i < 40; i++) {
      host.remove();
      await Promise.resolve();
      h.flush();
      if (host.isConnected) reattached++;
    }
    expect(reattached).toBe(20);
    expect(host.isConnected).toBe(false);
    h.deliver(INSPECT_CHANNEL.mode, modePick); // mode message clears degraded
    h.pointAt($(h, "button"));
    h.fire("mousemove", {});
    h.flush();
    expect(h.shadowRoots.some((s) => s.host.isConnected)).toBe(true);
  });

  it("the cap window slides: removals spread over time are all healed", async () => {
    const h = hovered();
    const { host } = h.shadowRoots[0]!;
    for (let i = 0; i < 30; i++) {
      h.setNow(1000 + i * 100);
      host.remove();
      await Promise.resolve();
      h.flush();
      expect(host.isConnected).toBe(true);
    }
  });

  it("re-asserts listeners every second with the same function identities and restores erased ones", () => {
    const h = pick();
    const initial = h.listenerLog.filter((l) => l.capture === true || (l.capture as { capture?: boolean })?.capture);
    expect(initial.length).toBeGreaterThanOrEqual(10);
    const fnByType = new Map(initial.map((l) => [l.type, l.fn]));
    const before = h.listenerLog.length;
    h.tick();
    const added = h.listenerLog.slice(before);
    expect(added.length).toBe(initial.length);
    for (const l of added) expect(fnByType.get(l.type)).toBe(l.fn);
    // Simulate document.open() erasing window listeners, then the next tick restoring them.
    for (const l of initial) h.win.removeEventListener(l.type, l.fn as EventListener, true);
    const seen: string[] = [];
    $(h, "button").addEventListener("click", () => seen.push("page"));
    h.fire("click", {}, $(h, "button"));
    expect(seen).toEqual(["page"]); // inspector blind while erased
    h.tick();
    seen.length = 0;
    clickOn(h, $(h, "button"));
    expect(seen).toEqual([]);
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.select)).toHaveLength(1);
  });

  it("does not run the re-assertion timer while off, and dispose removes everything", () => {
    const h = boot(PAGE);
    h.tick(); // off: nothing happens
    const baseline = h.listenerLog.length;
    h.tick();
    expect(h.listenerLog.length).toBe(baseline);
    h.deliver(INSPECT_CHANNEL.mode, modePick);
    h.pointAt($(h, "button"));
    h.fire("mousemove", {});
    h.flush();
    h.guest!.dispose();
    expect(h.shadowRoots.some((s) => s.host.isConnected)).toBe(false);
    const seen: string[] = [];
    $(h, "button").addEventListener("click", () => seen.push("click"));
    h.fire("click", {}, $(h, "button"));
    expect(seen).toEqual(["click"]);
  });
});

describe("natives", () => {
  it("a page that patches prototypes after start does not change what the guest measures", () => {
    const h = pick();
    const btn = $(h, "button");
    h.setRect(btn, { x: 1, y: 2, width: 3, height: 4 });
    h.win.Element.prototype.getBoundingClientRect = () => ({ x: 999, y: 999, width: 999, height: 999 }) as DOMRect;
    h.pointAt(btn);
    h.fire("mousemove", {});
    h.flush();
    expect(h.last(INSPECT_CHANNEL.hover)!.payload.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    void trusted;
  });
});

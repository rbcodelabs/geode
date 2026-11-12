import { describe, expect, it } from "vitest";
import { INSPECTOR_CAPS, INSPECTOR_STYLE_ALLOWLIST, OUTER_HTML_TRUNCATION_MARKER, type GuestSelectMessage } from "../../src/artifacts/inspector-protocol";
import { messageWithinCap, redactHtml, validateGuestSelect, validateHoverMessage, validateRectMessage } from "../../src/renderer/artifacts/selection-validator";

const valid = (): GuestSelectMessage => ({
  route: "/index.html#pricing",
  tag: "button",
  selector: "#buy",
  selectorAlternates: ["button.cta", "main > button"],
  textAnchor: { tag: "button", text: "Buy now" },
  landmark: "Pricing",
  outerHTML: { html: '<button id="buy" class="cta">Buy now</button>', truncated: false },
  ancestors: [{ tag: "div", id: "pro", classes: ["card", "pro"] }, { tag: "main", id: null, classes: [] }],
  computedStyles: { display: "inline-block", color: "rgb(1, 2, 3)" },
  boundingBox: { viewport: { x: 10, y: 20, width: 100, height: 40 } },
  viewport: { width: 1440, height: 900, devicePixelRatio: 2, scrollX: 0, scrollY: 120 },
  a11y: { role: "button", name: "Buy now", tabIndex: 0 },
});
const accept = (raw: unknown, redacted = false) => validateGuestSelect(raw, { redacted });
/** JSON.parse creates an own `__proto__` property, the way structured clone of a hostile message does. */
const withProto = (json: string) => JSON.parse(json);

describe("validateGuestSelect: accepts and rebuilds", () => {
  it("accepts a valid message and returns an equal, freshly built object", () => {
    const input = valid();
    const out = accept(input)!;
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out.ancestors).not.toBe(input.ancestors);
    expect(out.computedStyles).not.toBe(input.computedStyles);
  });

  it("drops unknown keys at every level", () => {
    const input = { ...valid(), extra: 1, textAnchor: { tag: "button", text: "x", evil: true }, a11y: { role: null, name: null, tabIndex: null, more: 1 } };
    const out = accept(input) as Record<string, unknown>;
    expect(out.extra).toBeUndefined();
    expect(out.textAnchor).toEqual({ tag: "button", text: "x" });
    expect(out.a11y).toEqual({ role: null, name: null, tabIndex: null });
  });

  it("accepts the empty selector (nothing verified in the guest) and null landmark", () => {
    expect(accept({ ...valid(), selector: "", selectorAlternates: [], landmark: null })).not.toBeNull();
  });

  it("dedupes alternates and drops one equal to the primary selector", () => {
    const out = accept({ ...valid(), selector: "a", selectorAlternates: ["a", "b", "b"] })!;
    expect(out.selectorAlternates).toEqual(["b"]);
  });
});

describe("validateGuestSelect: rejects (no partial acceptance)", () => {
  it.each([null, undefined, 5, "str", [], true])("non-object %j", (raw) => {
    expect(accept(raw)).toBeNull();
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects a hostile own key %s at any level", (key) => {
    const top = withProto(`{"${key}": {"polluted": true}}`);
    expect(accept({ ...valid(), ...top })).toBeNull();
    const nested = valid();
    (nested as unknown as Record<string, unknown>).textAnchor = { tag: "a", text: "t", ...withProto(`{"${key}": 1}`) };
    expect(accept(nested)).toBeNull();
    const style = { ...valid(), computedStyles: withProto(`{"display": "block", "${key}": "x"}`) };
    expect(accept(style)).toBeNull();
    const inAncestor = { ...valid(), ancestors: [{ tag: "div", id: null, classes: [], ...withProto(`{"${key}": 1}`) }] };
    expect(accept(inAncestor)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ["route too long", { route: "r".repeat(513) }],
    ["tag with uppercase", { tag: "Button" }],
    ["tag too long", { tag: "a".repeat(33) }],
    ["tag starting with digit", { tag: "1a" }],
    ["selector too long", { selector: "s".repeat(513) }],
    ["too many alternates", { selectorAlternates: ["1", "2", "3", "4"] }],
    ["alternate too long", { selectorAlternates: ["x".repeat(513)] }],
    ["alternates not strings", { selectorAlternates: [1] }],
    ["text anchor too long", { textAnchor: { tag: "a", text: "t".repeat(81) } }],
    ["text anchor bad tag", { textAnchor: { tag: "A B", text: "t" } }],
    ["landmark too long", { landmark: "l".repeat(121) }],
    ["landmark wrong type", { landmark: 3 }],
    ["outerHTML too long", { outerHTML: { html: "h".repeat(4097), truncated: true } }],
    ["outerHTML wrong flag", { outerHTML: { html: "h", truncated: "no" } }],
    ["too many ancestors", { ancestors: [1, 2, 3, 4].map(() => ({ tag: "div", id: null, classes: [] })) }],
    ["ancestor id too long", { ancestors: [{ tag: "div", id: "i".repeat(129), classes: [] }] }],
    ["too many classes", { ancestors: [{ tag: "div", id: null, classes: Array(9).fill("c") }] }],
    ["class too long", { ancestors: [{ tag: "div", id: null, classes: ["c".repeat(65)] }] }],
    ["style value too long", { computedStyles: { display: "d".repeat(201) } }],
    ["style value not a string", { computedStyles: { display: 3 } }],
    ["style object flooded", { computedStyles: Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`k${i}`, "v"])) }],
    ["NaN rect", { boundingBox: { viewport: { x: NaN, y: 0, width: 1, height: 1 } } }],
    ["Infinity rect", { boundingBox: { viewport: { x: 0, y: 0, width: Infinity, height: 1 } } }],
    ["huge number", { boundingBox: { viewport: { x: 1e7, y: 0, width: 1, height: 1 } } }],
    ["negative size", { boundingBox: { viewport: { x: 0, y: 0, width: -1, height: 1 } } }],
    ["rect missing", { boundingBox: {} }],
    ["viewport NaN", { viewport: { width: NaN, height: 1, devicePixelRatio: 1, scrollX: 0, scrollY: 0 } }],
    ["viewport missing field", { viewport: { width: 1, height: 1, devicePixelRatio: 1, scrollX: 0 } }],
    ["role too long", { a11y: { role: "r".repeat(65), name: null, tabIndex: null } }],
    ["name too long", { a11y: { role: null, name: "n".repeat(201), tabIndex: null } }],
    ["tabIndex out of range", { a11y: { role: null, name: null, tabIndex: 40000 } }],
    ["tabIndex fractional", { a11y: { role: null, name: null, tabIndex: 1.5 } }],
    ["route missing", { route: undefined }],
  ])("%s", (_name, patch) => {
    expect(accept({ ...valid(), ...patch })).toBeNull();
  });

  it("accepts the boundary values", () => {
    const ok = {
      ...valid(),
      route: "r".repeat(512), selector: "s".repeat(512), landmark: "l".repeat(120),
      textAnchor: { tag: "a", text: "t".repeat(80) },
      outerHTML: { html: "h".repeat(4096), truncated: true },
      ancestors: [1, 2, 3].map(() => ({ tag: "div", id: "i".repeat(128), classes: Array(8).fill("c".repeat(64)) })),
      computedStyles: { display: "d".repeat(200) },
      a11y: { role: "r".repeat(64), name: "n".repeat(200), tabIndex: 32767 },
    };
    expect(accept(ok)).not.toBeNull();
    expect(accept({ ...ok, a11y: { role: null, name: null, tabIndex: -1 } })).not.toBeNull();
  });
});

describe("computed style allowlist", () => {
  it("keeps only the 40 allowlisted names and drops the rest silently", () => {
    const styles = Object.fromEntries(INSPECTOR_STYLE_ALLOWLIST.map((n) => [n, "v"]));
    const out = accept({ ...valid(), computedStyles: { ...styles, cursor: "pointer", "--x": "1", behavior: "url(x)" } })!;
    expect(Object.keys(out.computedStyles).sort()).toEqual([...INSPECTOR_STYLE_ALLOWLIST].sort());
    expect(Object.keys(out.computedStyles)).toHaveLength(40);
  });
});

describe("viewport sanity", () => {
  it("rejects a devicePixelRatio that is zero, negative, non-finite or absurd, and absurd viewport sizes", () => {
    for (const dpr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 17, 1e6]) {
      expect(accept({ ...valid(), viewport: { ...valid().viewport, devicePixelRatio: dpr } }), String(dpr)).toBeNull();
    }
    expect(accept({ ...valid(), viewport: { ...valid().viewport, width: 100_001 } })).toBeNull();
    expect(accept({ ...valid(), viewport: { ...valid().viewport, devicePixelRatio: 16 } })).not.toBeNull();
    expect(accept({ ...valid(), viewport: { ...valid().viewport, devicePixelRatio: 0.5 } })).not.toBeNull();
  });
});

describe("redaction invariants (vault: read)", () => {
  it("drops the route's fragment and query and the landmark, but keeps the path", () => {
    const input = { ...valid(), route: "/index.html?note=Secret#/notes/Quarterly layoffs", landmark: "Quarterly layoffs" };
    const out = accept(input, true)!;
    expect(out.route).toBe("/index.html");
    expect(out.landmark).toBeNull();
    const plain = accept(input, false)!;
    expect(plain.route).toBe(input.route);
    expect(plain.landmark).toBe("Quarterly layoffs");
  });

  it("forces empty text anchor, null name and strips text and non-whitelisted attribute values from outerHTML", () => {
    const html = '<div id="x" class="c" title="private" data-note="n" role="r">Salary 100k<b data-variation="B" href="/secret">more</b></div>';
    const out = accept({ ...valid(), outerHTML: { html, truncated: false }, textAnchor: { tag: "div", text: "Salary" }, a11y: { role: "r", name: "Salary", tabIndex: null } }, true)!;
    expect(out.textAnchor.text).toBe("");
    expect(out.a11y.name).toBeNull();
    expect(out.outerHTML.html).toBe('<div id="x" class="c" title="..." data-note="..." role="r"><b data-variation="B" href="..."></b></div>');
  });

  it("leaves the content alone when not redacted", () => {
    const input = valid();
    expect(accept(input, false)!.outerHTML.html).toBe(input.outerHTML.html);
  });

  describe("redactHtml", () => {
    it("is linear on adversarial input and keeps the truncation marker", () => {
      const big = `<a ${'x="1" '.repeat(500)}>` + "t".repeat(3000) + OUTER_HTML_TRUNCATION_MARKER;
      const started = Date.now();
      const out = redactHtml(big);
      expect(Date.now() - started).toBeLessThan(200);
      expect(out).not.toContain("ttt");
      expect(out.endsWith(OUTER_HTML_TRUNCATION_MARKER)).toBe(true);
    });
    it("drops a dangling partial tag instead of leaking its attribute value", () => {
      expect(redactHtml('<p class="a">hi</p><a href="https://secret.exa')).toBe('<p class="a"></p>');
    });
    it("never lets text outside a tag survive, including entities and comments", () => {
      expect(redactHtml("a &amp; b<i>c</i><!--truncated--> tail")).toBe("<i></i><!--truncated-->");
    });
  });
});

describe("validateHoverMessage", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  it("accepts a pointer hover and rebuilds it", () => {
    const input = { tag: "div", rect, via: "pointer", extra: 1 };
    expect(validateHoverMessage(input)).toEqual({ tag: "div", rect, via: "pointer" });
  });
  it("accepts a keyboard hover with a label of at most 80 and rejects a longer one", () => {
    expect(validateHoverMessage({ tag: "div", rect, via: "keyboard", label: "x".repeat(80) })).toMatchObject({ via: "keyboard", label: "x".repeat(80) });
    expect(validateHoverMessage({ tag: "div", rect, via: "keyboard", label: "x".repeat(81) })).toBeNull();
  });
  it("rejects a label on a pointer hover (hover carries tag and rect only)", () => {
    expect(validateHoverMessage({ tag: "div", rect, via: "pointer", label: "x" })).toBeNull();
  });
  it.each([
    [null], [{ tag: "DIV", rect, via: "pointer" }], [{ tag: "div", rect, via: "touch" }],
    [{ tag: "div", rect: { x: NaN, y: 0, width: 1, height: 1 }, via: "pointer" }],
    [{ tag: "div", rect: { x: 0, y: 0, width: -1, height: 1 }, via: "pointer" }],
    [{ tag: "div", via: "pointer" }],
    [withProto('{"tag":"div","via":"pointer","rect":{"x":0,"y":0,"width":1,"height":1},"__proto__":{"a":1}}')],
  ])("rejects %j", (raw) => {
    expect(validateHoverMessage(raw)).toBeNull();
  });
});

describe("messageWithinCap", () => {
  it("accepts under 64 KB, rejects over, counts UTF-8 bytes, and survives cycles", () => {
    expect(messageWithinCap({ a: "x".repeat(1000) })).toBe(true);
    expect(messageWithinCap({ a: "x".repeat(INSPECTOR_CAPS.messageBytes) })).toBe(false);
    expect(messageWithinCap({ a: "€".repeat(25_000) })).toBe(false); // 75 KB in UTF-8, 25k units
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageWithinCap(cyclic)).toBe(false);
    expect(messageWithinCap(undefined)).toBe(false);
  });
});

describe("validateRectMessage (Phase 2a: live rect of the hovered or selected element)", () => {
  const rect = { x: 1, y: 2, width: 30, height: 40 };
  it("accepts a connected hover or selected rect and rebuilds it", () => {
    const input = { target: "selected", connected: true, rect: { ...rect }, extra: 1 };
    const out = validateRectMessage(input)!;
    expect(out).toEqual({ target: "selected", connected: true, rect });
    expect(out).not.toBe(input);
    expect(out.rect).not.toBe(input.rect);
    expect(validateRectMessage({ target: "hover", connected: true, rect })).toEqual({ target: "hover", connected: true, rect });
  });
  it("accepts an optional lower-case tag on a connected hover rect, and rejects a bad one or a tag on a selected rect (A9)", () => {
    expect(validateRectMessage({ target: "hover", connected: true, rect, tag: "button" })).toEqual({ target: "hover", connected: true, rect, tag: "button" });
    for (const tag of ["BUTTON", "", 5, "a".repeat(40), "x y"]) expect(validateRectMessage({ target: "hover", connected: true, rect, tag }), String(tag)).toBeNull();
    expect(validateRectMessage({ target: "selected", connected: true, rect, tag: "button" })).toBeNull();
    expect(validateRectMessage({ target: "hover", connected: false, rect: null, tag: "button" })).toBeNull();
  });
  it("accepts a disconnected report only with a null rect", () => {
    expect(validateRectMessage({ target: "selected", connected: false, rect: null })).toEqual({ target: "selected", connected: false, rect: null });
    expect(validateRectMessage({ target: "selected", connected: false, rect })).toBeNull();
    expect(validateRectMessage({ target: "selected", connected: true, rect: null })).toBeNull();
  });
  it("rejects unknown targets, non-boolean flags, bad rects and non-objects", () => {
    for (const bad of [
      null, undefined, "x", 1, [], { target: "other", connected: true, rect }, { target: "hover", connected: "yes", rect },
      { target: "hover", connected: true, rect: { ...rect, width: -1 } }, { target: "hover", connected: true, rect: { ...rect, x: Number.NaN } },
      { target: "hover", connected: true, rect: { ...rect, y: 1e9 } }, { target: "hover", connected: true, rect: [1, 2, 3, 4] },
      { target: "hover", connected: true },
    ]) expect(validateRectMessage(bad), JSON.stringify(bad)).toBeNull();
  });
  it("rejects a hostile own key at any level", () => {
    expect(validateRectMessage(withProto('{"target":"hover","connected":true,"rect":{"x":1,"y":2,"width":3,"height":4},"__proto__":{"a":1}}'))).toBeNull();
    expect(validateRectMessage(withProto('{"target":"hover","connected":true,"rect":{"x":1,"y":2,"width":3,"height":4,"constructor":1}}'))).toBeNull();
  });
});

describe("redactHtml with control characters before data: (review A7)", () => {
  it("never lets a control-character-prefixed data: value through (every non-keep value becomes ...)", () => {
    const html = '<a href="\u0001data:text/html,zzz" id="k\u0001data:x">t</a>';
    const out = redactHtml(html);
    expect(out).not.toContain("zzz");
    expect(out).toContain('href="..."');
  });
});

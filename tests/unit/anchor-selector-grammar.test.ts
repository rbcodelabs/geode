import { describe, expect, it } from "vitest";
import { INSPECTOR_CAPS } from "../../src/artifacts/inspector-protocol";
import { isRestrictedSelector } from "../../src/artifacts/anchor-selector";

/**
 * Phase 2b-i T3: stored selectors come from a file that may have been tampered with, so the guest only ever runs
 * the subset its own generator emits (ADR 0006 addendum 2, A2.7). Accept/reject table; everything outside the subset is
 * rejected without calling the DOM.
 */

const accepted: Array<[string, string]> = [
  ["tag", "div"],
  ["id", "#buy"],
  ["class", ".cta"],
  ["tag + two classes (generator shape)", "button.cta.primary"],
  ["child chain with nth-of-type", "main > section:nth-of-type(2) > div"],
  ["id anchored child", "#pro > button"],
  ["data-testid (generator shape)", "[data-testid=\"buy\"]"],
  ["attribute value with a space", "button[data-testid=\"a b\"]"],
  ["attribute value with escaped quote", "[data-x=\"say \\\"hi\\\"\"]"],
  ["attribute value with escaped backslash", "[data-x=\"a\\\\b\"]"],
  ["attribute value containing brackets and a combinator look-alike", "[data-x=\"a ] > b\"]"],
  ["bare attribute", "[disabled]"],
  ["tag with attribute", "a[href]"],
  ["nth-child", "div:nth-child(3)"],
  ["first-child", "ul > li:first-child"],
  ["last-child", "li:last-child"],
  ["first-of-type", "p:first-of-type"],
  ["last-of-type", "p:last-of-type"],
  ["universal", "*"],
  ["universal child", "* > p"],
  ["pseudo only compound", ":nth-child(1)"],
  ["body path (generator shape)", "body > main:nth-child(1) > section:nth-of-type(2) > div:nth-of-type(3)"],
  ["escaped leading digit id", "#\\31 23"],
  ["escaped colon in class", ".a\\:b"],
  ["escaped leading digit class", ".\\31 st"],
  ["non-ASCII ident", ".café"],
  ["svg camelCase tag", "svg > linearGradient"],
  ["descendant combinator", "div p"],
  ["12 compounds", Array.from({ length: 12 }, () => "div").join(" > ")],
  ["underscore and dash idents", "._a-b_c"],
  ["input attribute", "input[type=\"text\"]"],
];

const rejected: Array<[string, string]> = [
  ["empty", ""],
  ["leading space", " div"],
  ["trailing space", "div "],
  ["double space", "div  p"],
  ["child without spaces", "div>p"],
  ["child, no space after", "div >p"],
  ["child, no space before", "div> p"],
  ["selector list", "div, p"],
  ["adjacent sibling", "div + p"],
  ["general sibling", "div ~ p"],
  [":has", ":has(a)"],
  [":has on a tag", "div:has(> p)"],
  [":is", "div:is(a, b)"],
  [":where", ":where(a)"],
  [":not", ":not(.a)"],
  [":not on a tag", "div:not(.x)"],
  ["pseudo-element", "div::before"],
  ["state pseudo-class", "a:hover"],
  [":root", ":root"],
  ["html:root", "html:root"],
  ["nth-child formula", "a:nth-child(2n+1)"],
  ["nth-child keyword", "a:nth-child(odd)"],
  ["nth-child negative", "a:nth-child(-1)"],
  ["nth-child empty", "a:nth-child()"],
  ["nth-child too long", "a:nth-child(1234567)"],
  ["nth-last-child", "a:nth-last-child(1)"],
  ["only-child", "a:only-child"],
  ["namespace", "svg|rect"],
  ["namespace wildcard", "*|*"],
  ["attribute namespace operator", "[a|=b]"],
  ["unquoted attribute value", "[a=b]"],
  ["case flag", "[a=\"b\" i]"],
  ["attribute includes", "[a~=\"b\"]"],
  ["attribute prefix", "[a^=\"b\"]"],
  ["attribute without a name", "[=\"b\"]"],
  ["unterminated attribute value", "[a=\"b]"],
  ["space before bracket", "[a=\"b\" ]"],
  ["dangling colon", "div:"],
  ["bare hash", "#"],
  ["bare dot", "."],
  ["digit-leading class", ".1a"],
  ["dash digit id", "#-1"],
  ["lone dash", ".-"],
  ["hash at end", "div#"],
  ["double dot", "div.a."],
  ["at rule", "@media"],
  ["newline", "div\n"],
  ["tab combinator", "div\tp"],
  ["NUL", "div\u0000"],
  ["control character in value", "div[data-x=\"\u0001\"]"],
  ["dangling escape", "a\\"],
  ["escape only", "\\"],
  ["comment", "div p /* c */"],
  ["value over 120 units", `div[data-x="${"a".repeat(121)}"]`],
  ["13 compounds", Array.from({ length: 13 }, () => "div").join(" > ")],
  ["over 512 units", `${"a".repeat(INSPECTOR_CAPS.selectorUnits + 1)}`],
  ["bracket injection", "div[data-x=\"a\"][b=c]"],
  ["tag in the middle of a compound", ".adiv#x div.b[c]foo"],
];

describe("isRestrictedSelector: the guest's selector grammar subset", () => {
  it.each(accepted)("accepts %s", (_name, selector) => {
    expect(isRestrictedSelector(selector)).toBe(true);
  });

  it.each(rejected)("rejects %s", (_name, selector) => {
    expect(isRestrictedSelector(selector)).toBe(false);
  });

  it("treats a class followed by a tag as an ordinary descendant selector", () => {
    expect(isRestrictedSelector(".a div")).toBe(true);
  });

  it("accepts exactly 512 units and rejects 513", () => {
    expect(isRestrictedSelector("a".repeat(512))).toBe(true);
    expect(isRestrictedSelector("a".repeat(513))).toBe(false);
  });

  it("never throws, whatever it is given", () => {
    for (const hostile of [null, undefined, 3, {}, [], "\ud800", "a".repeat(100_000)]) {
      expect(() => isRestrictedSelector(hostile as never)).not.toThrow();
      expect(isRestrictedSelector(hostile as never)).toBe(false);
    }
  });

  it("is linear: a 512-unit adversarial selector is judged quickly", () => {
    const started = performance.now();
    for (let i = 0; i < 200; i++) isRestrictedSelector(`${"[a=\"".repeat(40)}`);
    for (let i = 0; i < 200; i++) isRestrictedSelector("a:".repeat(250));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("attribute value cap matches the selection generator (128)", () => {
  it("accepts 128 units and rejects 129", () => {
    expect(isRestrictedSelector(`div[data-x="${"a".repeat(128)}"]`)).toBe(true);
    expect(isRestrictedSelector(`div[data-x="${"a".repeat(129)}"]`)).toBe(false);
  });
});

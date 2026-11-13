import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { INSPECTOR_CAPS } from "../../src/artifacts/inspector-protocol";
import { isRestrictedSelector } from "../../src/artifacts/anchor-selector";

/**
 * QA (G2, independent): extra hostile-input coverage for the guest selector grammar beyond the engineer's table.
 * Soundness is what matters (T3): nothing accepted may smuggle a selector list, a sibling combinator, a functional
 * pseudo or anything else outside the generator's subset. The property test uses an oracle written independently of
 * the implementation (strip quoted values and escapes, then inspect what is left) over a few hundred thousand inputs.
 */

const rejects: Array<[string, string]> = [
  // unicode and exotic whitespace / separators
  ["no-break space combinator", "div\u00a0p"],
  ["ideographic space combinator", "div\u3000p"],
  ["line separator", "div\u2028p"],
  ["zero-width space inside a tag", "di\u200bv"],
  ["bidi override in tag", "div\u202e"],
  ["fullwidth greater-than as combinator", "div \uff1e p"],
  ["unicode tag name (tag is ASCII only)", "dív"],
  ["lone surrogate in a tag", "div\ud800"],
  ["BOM prefix", "\ufeffdiv"],
  ["NEL", "div\u0085p"],
  // lists and injection
  ["comma no space", "div,p"],
  ["comma inside an ident escape-look-alike", "div\\,p"],
  ["list via newline", "div\np"],
  ["list via CR", "div\rp"],
  ["list via form feed", "div\fp"],
  ["quote break-out then list", "[a=\"x\"], body"],
  ["quote break-out with an escaped backslash then list", "[a=\"x\\\\\"], body"],
  ["unterminated escape at end of value", "[a=\"x\\\"]"],
  ["attribute close then combinator char", "[a=\"x\"]+p"],
  ["attribute close then tilde", "[a=\"x\"]~p"],
  ["attribute close then pipe", "[a=\"x\"]|p"],
  ["second attribute with operator", "[a=\"x\"][b|=\"y\"]"],
  ["attribute value with a raw newline", "[a=\"x\ny\"]"],
  ["attribute value with a raw tab", "[a=\"x\ty\"]"],
  ["attribute value with DEL", "[a=\"x\u007fy\"]"],
  ["attribute value with unescaped backslash-n", "[a=\"x\\ny\"]"],
  ["attribute value with a hex escape (only \\\" and \\\\ are escapes in values)", "[a=\"\\41 \"]"],
  ["attribute name starting with a digit", "[1a]"],
  ["attribute name with a non-ASCII letter", "[é]"],
  ["attribute name with a colon only is fine but a pipe is not", "[x|y]"],
  ["attribute with single quotes", "[a='b']"],
  ["attribute with backticks", "[a=`b`]"],
  ["attribute with i flag no space", "[a=\"b\"i]"],
  ["attribute with s flag", "[a=\"b\" s]"],
  ["empty brackets", "[]"],
  ["nested brackets", "[[a]]"],
  ["attribute operator *=", "[a*=\"b\"]"],
  ["attribute operator $=", "[a$=\"b\"]"],
  ["bare attribute followed by junk", "[a]b"],
  ["bare attribute with trailing space inside", "[a ]"],
  // functional pseudos and nesting
  [":has chain", "div:has(div:has(div:has(div)))"],
  [":has with child combinator first", ":has(> a)"],
  ["deeply nested :not", ":not(:not(:not(:not(:not(a)))))"],
  [":is with list", ":is(a,b,c)"],
  [":where empty", ":where()"],
  [":matches", ":matches(a)"],
  [":-webkit-any", ":-webkit-any(a)"],
  [":nth-child with of S", "a:nth-child(1 of b)"],
  [":nth-child with spaces", "a:nth-child( 1 )"],
  [":nth-child with plus", "a:nth-child(+1)"],
  [":nth-child with hex", "a:nth-child(0x1)"],
  [":nth-child with unicode digit", "a:nth-child(\u0661)"],
  [":nth-child with exponent", "a:nth-child(1e3)"],
  [":nth-child with 7 digits", "a:nth-child(1000000)"],
  [":nth-last-of-type", "a:nth-last-of-type(1)"],
  [":only-of-type", "a:only-of-type"],
  [":empty", "a:empty"],
  [":focus", "a:focus"],
  [":checked", "input:checked"],
  [":is uppercase variant of an allowed pseudo", "a:FIRST-CHILD"],
  [":first-child with arguments", "a:first-child(1)"],
  [":first-child followed by letters", "a:first-childish"],
  ["pseudo-element ::first-line", "p::first-line"],
  ["::slotted", "::slotted(a)"],
  [":host", ":host"],
  [":global", ":global(a)"],
  ["shadow piercing", "a >>> b"],
  ["deep combinator", "a /deep/ b"],
  ["column combinator", "a || b"],
  ["namespace in tag", "ns|a"],
  // idents and escapes
  ["ident ending with a lone backslash", "#a\\"],
  ["backslash newline", "#a\\\nb"],
  ["backslash NUL", "#a\\\u0000"],
  ["escape of DEL", ".a\\\u007f"],
  ["double dash then digit then escape error", "#--\\"],
  ["hash with space", "# a"],
  ["class with space after dot", ". a"],
  ["id starting with digit unescaped", "#1a"],
  ["class starting with dash digit", ".-1a"],
  ["id with unescaped colon", "#a:b"],
  ["class with unescaped slash", ".w-1/2"],
  ["class with unescaped bracket", ".a[0]"],
  ["tag with underscore", "my_el"],
  ["tag with dot inside is a class", "a.b.c."],
  ["compound starting with a digit", "1div"],
  ["compound starting with a dash tag", "-div"],
  // structure
  ["only a combinator", ">"],
  ["leading combinator", "> div"],
  ["trailing combinator", "div >"],
  ["trailing combinator with space", "div > "],
  ["double child combinator", "div > > p"],
  ["child combinator then descendant", "div >  p"],
  ["descendant spaces 3", "div   p"],
  ["tab as descendant", "div\tp"],
  ["13 compounds mixed combinators", "a b > c d > e f > g h > i j > k l > m"],
  ["13 compounds of nth-child", Array.from({ length: 13 }, (_, i) => `a:nth-child(${i + 1})`).join(" > ")],
  ["5000 compounds", Array.from({ length: 5000 }, () => "a").join(" ")],
  ["10 MB of letters", "a".repeat(10_000_000)],
  ["10 MB of brackets", "[".repeat(10_000_000)],
  ["513 chars of valid class", `.${"a".repeat(512)}`],
  ["a value of 129 escaped quotes (units, not chars)", `[a="${'\\"'.repeat(129)}"]`],
  ["a value of 129 plain chars", `[a="${"x".repeat(129)}"]`],
  ["a non-string number", 5 as unknown as string],
  ["a String object", new String("div") as unknown as string],
  ["a one-element array", ["div"] as unknown as string],
  ["undefined", undefined as unknown as string],
];

const accepts: Array<[string, string]> = [
  ["a value of exactly 120 plain chars", `[a="${"x".repeat(120)}"]`],
  ["a value of exactly 120 escaped quotes (units)", `[a="${'\\"'.repeat(120)}"]`],
  ["empty attribute value", "[a=\"\"]"],
  ["attribute name with dot and colon", "[xlink:href]"],
  ["attribute name with leading underscore", "[_a]"],
  ["attribute value containing everything hostile but quoted", "[a=\"</style><script>alert(1)</script>, :has(*) ~ + > | ]\"]"],
  ["attribute value with a unicode line separator", "[a=\"\u2028\"]"],
  ["attribute value with emoji", "[a=\"\u{1f600}\"]"],
  ["id that is entirely a hex escape", "#\\31 "],
  ["id that ends with a hex escape followed by the child combinator", "#\\31  > div:nth-of-type(1)"],
  ["class ending in a 6 digit hex escape with terminator", ".a\\10ffff "],
  ["hex escape without terminator before a combinator char is a normal ident char", ".a\\31 b"],
  ["double dash ident", "#--"],
  ["dash escape", ".\\-"],
  ["dash then escaped digit", ".-\\31 "],
  ["12 compounds with mixed combinators", "a b > c d > e f > g h > i j > k l"],
  ["nth-child with 6 digits", "a:nth-child(999999)"],
  ["nth-child(0)", "a:nth-child(0)"],
  ["many simple pseudos", "li:first-child:last-child:first-of-type:last-of-type"],
  ["universal with everything", "*#a.b[c=\"d\"]:nth-child(2)"],
  ["svg camelCase element", "foreignObject > div"],
  ["custom element tag with digits and dashes", "x-widget-2 > y-1"],
];

describe("QA G2 grammar: additional rejects", () => {
  it.each(rejects)("rejects %s", (_name, selector) => {
    expect(isRestrictedSelector(selector)).toBe(false);
  });
});

describe("QA G2 grammar: additional accepts (boundaries)", () => {
  it.each(accepts)("accepts %s", (_name, selector) => {
    expect(isRestrictedSelector(selector)).toBe(true);
  });
});

describe("QA G2 grammar: cost", () => {
  it("rejects a 10 MB input without scanning it (length gate first)", () => {
    const big = "[".repeat(10_000_000);
    const t = performance.now();
    for (let i = 0; i < 20; i++) isRestrictedSelector(big);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it("worst 512-unit shapes are linear: 20,000 evaluations of each stay far below a second", () => {
    const shapes = [
      "a ".repeat(255) + "a",
      "[a=\"" + "\\\"".repeat(60) + "\"]",
      ("a:nth-child(999999) ").repeat(24),
      ".\\31 ".repeat(100),
      "#" + "\\".repeat(255) + "a",
      "a".repeat(511) + ":",
      "[a=\"" + "x".repeat(120) + "\"]".repeat(30),
    ];
    for (const shape of shapes) {
      const t = performance.now();
      for (let i = 0; i < 20_000; i++) isRestrictedSelector(shape);
      expect(performance.now() - t, shape.slice(0, 30)).toBeLessThan(1500);
    }
  });
});

// ---- property test with an independent oracle ----

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const TOKENS = [
  "div", "a", "*", "svg", "foreignObject", "x-y", "#", ".", "[", "]", "=", "\"", "\\\"", "\\\\", "\\", "\\31 ", "\\a ", " ", " > ", ">", ",", "+", "~", "|", ":",
  "::", ":has(", ":not(", ":is(", ":where(", ":nth-child(", ":nth-of-type(", ":first-child", ":last-child", ":first-of-type", ":last-of-type", ")", "(", "1", "23", "0",
  "data-x", "id", "-", "_", "é", "\u{1f600}", "\n", "\t", "\u0000", "/*", "*/", "{", "}", ";", "'", "i", "s", "\u2028", "&", "@", "!", "$", "^", "%",
];

function randomSelector(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 14);
  let out = "";
  for (let i = 0; i < n; i++) out += TOKENS[Math.floor(rand() * TOKENS.length)];
  return out;
}

const VALID_SEEDS = [
  "button.cta.primary", "#pro > button", "[data-testid=\"buy\"]", "main > section:nth-of-type(2) > div:nth-child(3)", "#\\31 23 > p",
  "body > main:nth-child(1) > section", "svg > linearGradient", "a[href]", "ul > li:first-child", ".w\\-1\\/2.hover\\:x", "x-y[data-a=\"b \\\" c\"]",
];

function mutate(seed: string, rand: () => number): string {
  let s = seed;
  const steps = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < steps; i++) {
    const pos = Math.floor(rand() * (s.length + 1));
    const token = TOKENS[Math.floor(rand() * TOKENS.length)]!;
    const kind = Math.floor(rand() * 3);
    if (kind === 0) s = s.slice(0, pos) + token + s.slice(pos);
    else if (kind === 1) s = s.slice(0, pos) + s.slice(pos + 1 + Math.floor(rand() * 3));
    else s = s.slice(0, pos) + token + s.slice(pos + 1);
  }
  return s;
}

/**
 * The oracle: remove what the grammar allows to contain arbitrary characters (quoted values, escapes), then what is
 * left may only be built from a small safe alphabet, with no list/sibling/functional syntax left over.
 */
function violatesSafety(selector: string): string | null {
  if (selector.length === 0 || selector.length > 512) return "length";
  let rest = selector.replace(/="(?:[^"\\]|\\["\\])*"/g, '=""');
  rest = rest.replace(/\\[0-9a-fA-F]{1,6} ?|\\[^\n\r\f\u0000-\u001f\u007f]/g, "E");
  // attribute names may carry ":" and "." in the grammar (the design's rule): neutralize them before the pseudo checks.
  rest = rest.replace(/\[[A-Za-z_:][-A-Za-z0-9_:.]*(?:="")?\]/g, "[A]");
  if (/\\/.test(rest)) return "stray backslash";
  if (/["']/.test(rest.replace(/=""/g, "="))) return "stray quote";
  if (/[\u0000-\u001f\u007f]/.test(rest)) return "control char outside a value";
  if (/[,+~|/@{};!$^%&`<]/.test(rest)) return "forbidden punctuation outside a value";
  if (/::/.test(rest)) return "pseudo-element";
  const pseudos = rest.match(/:[^\s>.#[:]*/g) ?? [];
  for (const p of pseudos) if (!/^:(?:first-child|last-child|first-of-type|last-of-type|nth-child\(\d{1,6}\)|nth-of-type\(\d{1,6}\))$/.test(p)) return `pseudo ${p}`;
  const stripped = rest.replace(/:(?:nth-child|nth-of-type)\(\d{1,6}\)/g, "");
  if (/[()]/.test(stripped)) return "parenthesis outside nth-*";
  if (/\s[^>\s]|\s$|^\s/.test(rest.replace(/ > /g, " ").replace(/^ /, "!"))) {
    // whitespace must be a single space combinator or " > "
  }
  if (/(?:^|[^E]) {2,}|^ | $|>[^ ]|[^ ]>| > >|>  /.test(rest)) return "bad whitespace/combinator";
  const compounds = rest.split(/ > | /);
  if (compounds.length > 12) return "more than 12 compounds";
  if (compounds.some((c) => c === "")) return "empty compound";
  if (!/^[A-Za-z0-9_\-\u0080-\uffff*#.\[\]=":() >E]+$/.test(rest)) return "alphabet";
  return null;
}

describe("QA G2 grammar: property fuzz against an independent safety oracle", () => {
  it("nothing accepted violates the oracle (random token soup, 150k inputs)", () => {
    const rand = rng(0xc0ffee);
    let accepted = 0;
    const violations: string[] = [];
    for (let i = 0; i < 150_000; i++) {
      const s = randomSelector(rand);
      if (isRestrictedSelector(s)) {
        accepted++;
        const why = violatesSafety(s);
        if (why) violations.push(`${JSON.stringify(s)}: ${why}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(accepted).toBeGreaterThan(200); // the fuzz must actually reach the accept path
  });

  it("nothing accepted violates the oracle (mutations of valid selectors, 150k inputs)", () => {
    const rand = rng(0xbadc0de);
    let accepted = 0;
    const violations: string[] = [];
    for (let i = 0; i < 150_000; i++) {
      const s = mutate(VALID_SEEDS[Math.floor(rand() * VALID_SEEDS.length)]!, rand);
      if (isRestrictedSelector(s)) {
        accepted++;
        const why = violatesSafety(s);
        if (why) violations.push(`${JSON.stringify(s)}: ${why}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(accepted).toBeGreaterThan(2000);
  });

  it("every accepted selector is also valid CSS for a real selector engine (never throws) and never returns more than the whole tree", () => {
    const dom = new JSDOM(`<body><div id="1" class="a"><p data-x="b">t</p></div></body>`);
    const doc = dom.window.document;
    const rand = rng(0x5eed);
    const throwing: string[] = [];
    let accepted = 0;
    for (let i = 0; i < 60_000; i++) {
      const s = i % 2 ? mutate(VALID_SEEDS[Math.floor(rand() * VALID_SEEDS.length)]!, rand) : randomSelector(rand);
      if (!isRestrictedSelector(s)) continue;
      accepted++;
      if ([...s.replace(/="(?:[^"\\]|\\["\\])*"/g, '=""').matchAll(/\[([A-Za-z_:][-A-Za-z0-9_:.]*)/g)].some((m) => /[:.]/.test(m[1]!))) continue; // see the attribute-name note below
      try { doc.querySelectorAll(s); } catch (e) { throwing.push(`${JSON.stringify(s)}: ${(e as Error).message.slice(0, 60)}`); }
    }
    // A throw is harmless (the guest wraps the call in try/catch -> detached) but a grammar that accepts invalid CSS is sloppy: report.
    expect(accepted).toBeGreaterThan(500);
    expect(throwing.slice(0, 10)).toEqual([]);
  });

  // Informational (QA-G2-3, no security impact): the grammar admits ":" and "." in an UNESCAPED attribute name, which is not valid CSS,
  // so a real selector engine throws SyntaxError; the guest wraps every query in try/catch, so the anchor is simply detached.
  it("documents that [a.b] and [a:b] pass the grammar but not the DOM (harmless: the query throws inside try/catch)", () => {
    const doc = new JSDOM("<body></body>").window.document;
    for (const s of ["[a.b]", "[xlink:href]", "[a:b=\"c\"]"]) {
      expect(isRestrictedSelector(s)).toBe(true);
      expect(() => doc.querySelectorAll(s)).toThrow();
    }
  });

  it("caps come from the shared constants the generator also uses", () => {
    expect(INSPECTOR_CAPS.selectorUnits).toBe(512);
  });
});

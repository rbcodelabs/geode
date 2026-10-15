import { describe, expect, it } from "vitest";
import { maskMarkdownCode } from "../../src/wiki/code-mask";

describe("portable code masking", () => {
  it("matches equal-width inline delimiters without pairing different widths", () => {
    const text = 'before ``one ` two`` after `open';
    expect(maskMarkdownCode(text)).toBe('before ' + ' '.repeat(13) + ' after `open');
  });
  it("preserves every CRLF offset while masking fenced content", () => {
    const text = '~~~language\r\n[[hidden]]\r\n~~~~\r\n[[visible]]';
    const masked = maskMarkdownCode(text);
    expect(masked.length).toBe(text.length);
    expect(masked.indexOf('[[visible]]')).toBe(text.indexOf('[[visible]]'));
    expect(masked).not.toContain('hidden');
    expect([...masked.matchAll(/\r\n/g)].map(match => match.index)).toEqual([...text.matchAll(/\r\n/g)].map(match => match.index));
  });
  it("does not pair code spans across a blank paragraph", () => {
    expect(maskMarkdownCode('`unclosed\n\nother`')).toBe('`unclosed\n\nother`');
    expect(maskMarkdownCode('`code\ncontinued`')).toBe('     \n          ');
  });
  it("handles many distinct unmatched delimiter widths within one paragraph", () => {
    const text = 'prefix ' + Array.from({ length: 250 }, (_, index) => '`'.repeat(index + 1) + 'x').join(' ');
    const start = performance.now();
    expect(maskMarkdownCode(text)).toBe(text);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

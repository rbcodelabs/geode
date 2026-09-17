import { stripCommentMetadataWithMap } from "../renderer/comments/model";

/**
 * Portable search query primitives.
 *
 * `docs/design/headless-phase0.md`'s extraction dependency map flags
 * `src/renderer/views/search-view.ts` as "pure term matching alongside
 * view/icon imports", with the remediation "extract query primitives when
 * local engine adds search". The write-capable folder provider adds search, so
 * that condition is now met and these move here.
 *
 * Nothing about the matching behaviour changes. The only difference is that
 * the file type is now a type parameter instead of the desktop `TFile`: the
 * matcher never needed more than a name, a path, and an injected tag lookup,
 * and saying so is what makes it portable. The desktop search view re-exports
 * these and binds the parameter back to `TFile`, so existing call sites and
 * tests are untouched.
 *
 * Scope note: this does NOT converge `createWikiSnapshot`'s `search()` onto
 * these primitives. That function answers a deliberately different question —
 * a bounded, ASCII-folded literal scan that also reports completeness and
 * truncation — rather than evaluating this operator query language. Merging
 * the two is a real design change to both contracts, not an extraction, and it
 * is left as follow-up rather than absorbed here.
 */

export interface SearchTerm {
  op: "text" | "file" | "path" | "tag" | "content" | "line";
  value: string;
  negated: boolean;
  regex: RegExp | null;
}

export interface SearchSnippet {
  text: string;
  offset: number;
}

/** The minimum a file must expose to be searchable. */
export interface SearchableFile {
  name: string;
  path: string;
}

/** A tag, as far as search is concerned. */
export interface SearchableTag {
  tag: string;
}

export interface SearchMatch<T> {
  file: T;
  snippets: SearchSnippet[];
}

/** Parse a query into terms. Supports operators, "phrases", -negation, /regex/. */
export function parseQuery(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const re = /(-)?(?:(file|path|tag|content|line):)?(?:"([^"]*)"|\/((?:[^\/\\]|\\.)+)\/|(\S+))/g;
  for (const m of query.matchAll(re)) {
    const negated = !!m[1];
    const op = (m[2] as SearchTerm["op"]) || "text";
    let value = m[3] ?? m[5] ?? "";
    let regex: RegExp | null = null;
    if (m[4] !== undefined) {
      try {
        regex = new RegExp(m[4], "gi");
      } catch {
        value = m[4];
      }
    }
    if (!value && !regex) continue;
    terms.push({ op, value: value.toLowerCase(), negated, regex });
  }
  return terms;
}

/**
 * Evaluate a parsed query's terms against a single file. Pure aside from the
 * injected `getTags` lookup (tag matching needs an index, which the matcher
 * deliberately does not own). All other operators only need the file's name,
 * its path and its content, so this runs with no DOM or Electron dependency.
 */
export function matchFileAgainstTerms<T extends SearchableFile>(
  file: T,
  content: string | null,
  terms: SearchTerm[],
  getTags: (file: T) => SearchableTag[],
): SearchMatch<T> | null {
  const snippets: SearchSnippet[] = [];
  const searchable = content === null ? null : stripCommentMetadataWithMap(content);
  if (searchable) content = searchable.text;
  const rawContent = content;
  const lower = content?.toLowerCase() ?? "";
  const addSnippet = (index: number, len: number) => {
    const raw = rawContent ?? "";
    const lineStart = raw.lastIndexOf("\n", index) + 1;
    let lineEnd = raw.indexOf("\n", index + len);
    if (lineEnd < 0) lineEnd = raw.length;
    snippets.push({ offset: searchable?.toSourceOffset(index) ?? index, text: raw.slice(lineStart, lineEnd).trim().slice(0, 250) });
  };
  for (const term of terms) {
    let hit = false;
    switch (term.op) {
      case "file":
        hit = file.name.toLowerCase().includes(term.value);
        break;
      case "path":
        hit = file.path.toLowerCase().includes(term.value);
        break;
      case "tag": {
        const tags = getTags(file);
        const want = term.value.replace(/^#/, "");
        hit = tags.some((t) => {
          const tl = t.tag.toLowerCase();
          return tl === want || tl.startsWith(want + "/");
        });
        break;
      }
      case "text":
      case "content":
      case "line": {
        if (content == null) break;
        if (term.regex) {
          term.regex.lastIndex = 0;
          const m = term.regex.exec(content);
          if (m) {
            hit = true;
            if (!term.negated) addSnippet(m.index, m[0].length);
          }
        } else {
          const idx = lower.indexOf(term.value);
          if (idx !== -1) {
            hit = true;
            if (!term.negated) addSnippet(idx, term.value.length);
          }
        }
        break;
      }
    }
    if (term.negated ? hit : !hit) return null;
  }
  return { file, snippets };
}

export interface Pos {
  line: number;
  ch: number;
  offset: number;
}

export interface Loc {
  start: Pos;
  end: Pos;
}

export interface LinkCache {
  link: string; // raw link target, e.g. "Note#Heading"
  displayText: string;
  position: Loc;
  isEmbed: boolean;
}

export interface TagCache {
  tag: string; // without '#'
  position: Loc;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: Loc;
}

export interface SectionCache {
  /** Block type: "heading" | "paragraph" | "list" | "code" | "yaml" | … */
  type: string;
  position: Loc;
  id?: string;
}

export interface ListItemCache {
  position: Loc;
  /**
   * Line number of this item's parent list item. Negative when the item is
   * top-level: all roots in one list share the negative first-item line.
   */
  parent: number;
  /**
   * The single character inside a task checkbox (`' '` for an open task,
   * `'x'` for done, `'/'`, `'-'`, etc.). ABSENT for a plain (non-checkbox)
   * list item — obsidian-tasks skips items whose `task` is undefined.
   */
  task?: string;
  /** Trailing block id (`^id`) on the item's line, if present. */
  id?: string;
}

export interface CachedMetadata {
  // Obsidian-faithful: this key is ABSENT (undefined) when a note has no
  // frontmatter — real plugins branch on `frontmatter !== undefined` (e.g.
  // obsidian-tasks deep-clones it only when defined; a `null` here passes that
  // guard and then crashes on `clone.tags = …`). `| null` is retained so the
  // many existing call sites that coalesce `?? null` still type-check.
  frontmatter?: Record<string, unknown> | null;
  frontmatterEndOffset: number;
  frontmatterPosition?: Loc;
  frontmatterLinks?: FrontmatterLinkCache[];
  blocks?: Record<string, BlockCache>;
  footnotes?: FootnoteCache[];
  links: LinkCache[];
  embeds: LinkCache[];
  tags: TagCache[];
  headings: HeadingCache[];
  aliases: string[];
  /**
   * List/checklist items in the note. Obsidian-faithful: ABSENT (undefined)
   * when the note has no list items — obsidian-tasks branches on
   * `listItems === undefined` to skip a file entirely, so an empty array
   * would mean "scanned, none" rather than "not scanned".
   */
  listItems?: ListItemCache[];
  /**
   * Top-level block sections (paragraph/list/heading/code/…). obsidian-tasks
   * requires every list item's line to be covered by a section — it looks up
   * `getSection(line, sections)` and SKIPS any item whose line has no section
   * (that lookup is why a ```tasks query rendered 0 rows before sections
   * existed). Present when the note has any block content.
   */
  sections?: SectionCache[];
  /**
   * Inline footnote references (`[^id]`). ABSENT when the note has none,
   * following the same "present only when found" convention as `listItems`
   * and `sections` above.
   */
  footnoteRefs?: FootnoteRefCache[];
  /** Markdown reference links (`[text][id]`, `[text][]`). ABSENT when the note has none. */
  referenceLinks?: ReferenceLinkCache[];
}

// NOTE: Geode's `Loc` is the {start, end} span (what Obsidian calls `Pos`),
// and Geode's `Pos` is the {line, ch, offset} point. `position: Loc` here is
// the span, consistent with every other cache type in this file.
export interface FootnoteRefCache {
  id: string;
  position: Loc;
}

export interface ReferenceLinkCache {
  id: string;
  /** Destination URL or path from the referenced definition. */
  link: string;
  position: Loc;
}

export interface BlockCache { id: string; position: Loc }
export interface FootnoteCache { id: string; position: Loc }
export interface FrontmatterLinkCache {
  key: string;
  link: string;
  original: string;
  displayText?: string;
  /** Actual authored YAML scalar span, retained for internal source projections. */
  position?: Loc;
}

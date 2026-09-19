import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueryProjectionOptions } from "../src/wiki/query-projection";

/**
 * The fixture VM A publishes and VM B restores, and the exact queries both
 * project.
 *
 * It is shared source rather than duplicated constants for one reason: the
 * equality claim is only worth something if both processes ask the *same*
 * questions. Two hand-maintained copies of a query list would drift, and the
 * first drift would silently narrow the claim instead of failing it.
 *
 * Sharing a module is not sharing state. VM A and VM B are separate OS
 * processes with separate heaps; this gives them the same fixture definition,
 * not any runtime value. VM B never reads VM A's vault directory, its output,
 * or its projection — only the disposable schema.
 */

/**
 * The vault VM B restores. Deliberately not `vault-a`: the publish proof goes
 * on to mutate `vault-a` through conflict, rollback and mismatch scenarios, so
 * its final contents are *not* the snapshot VM A captured. This vault is
 * published exactly once and never touched again, which is what makes
 * "identical to VM A's pre-publish snapshot" a statement about restore rather
 * than about which scenarios happened to run last.
 */
export const RESTORE_VAULT_ID = "vault-restore";

/** Identical bytes at two paths: one stored object, two catalog entries. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 0xff, 0xfe]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0x7f, 0x80]);

/** Content types by extension, for the publisher. The catalog has no MIME sniffing. */
export const PROOF_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".pdf": "application/pdf",
});

export function proofContentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return PROOF_CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * How many generated lines the wide note carries.
 *
 * Sized so the restore payload runs past *several* 64 KiB pipe boundaries, not
 * just one. That margin is the point, and it was measured rather than guessed:
 * an earlier version of this note was 179 KB, crossed two boundaries, and both
 * of them happened to land on an ASCII byte — so the corruption it exists to
 * catch did not occur and the proof passed against the unfixed adapter. Only a
 * boundary landing *inside* a multi-byte character corrupts anything.
 */
const WIDE_NOTE_LINES = 1800;

/**
 * A note deliberately larger than a pipe chunk, made entirely of multi-byte text.
 *
 * `notes/Deep note.md` already carries non-ASCII, which was the right instinct
 * and did not go far enough: the whole fixture was a few hundred bytes, so the
 * JSON a restore reads back over `psql`'s stdout never approached 64 KiB and
 * every chunk arrived whole. That made a real corruption bug unreachable — the
 * adapter decoded each stdout Buffer independently, so any multi-byte character
 * straddling a chunk boundary became U+FFFD, and nothing downstream noticed:
 * every JSON structural character is ASCII so the payload still parsed, and
 * notes carry no content address for `verifyRestoredVault` to check.
 *
 * This note makes that boundary reachable. Lines vary in length and mix two-,
 * three- and four-byte characters, so chunk boundaries do not land on character
 * boundaries by construction, and each line is numbered so a projection diff
 * points at where corruption started rather than just reporting inequality.
 *
 * Its alphabet deliberately avoids every term in `PROOF_PROJECTION`'s search
 * list. Reusing `café` or `日本語` here would put a snippet from all three
 * thousand lines into two search results and inflate the projection past a
 * megabyte — a diff nobody could read, to prove nothing the note is here for.
 * The boundary crossing depends on the note's *bytes*, not on its words.
 *
 * The line index sits *inside* the line rather than in front of it for the
 * same reason: a leading `1. ` makes every line an ordered-list item, and
 * thousands of parsed list items land in the note's projected `metadata`.
 *
 * The bulk of each line is a run of four-byte characters with as little ASCII
 * as possible. Density is what decides whether a boundary does any damage:
 * inside a four-byte run, three of every four byte offsets sit strictly inside
 * a character, whereas a line padded out with spaces and digits offers a
 * boundary plenty of harmless ASCII to land on.
 */
export function buildWideNoteText(): string {
  const parts = ["# Wide note\r\n\r\nBack to [[Index]].\r\n\r\n"];
  for (let index = 0; index < WIDE_NOTE_LINES; index += 1) {
    // Lengths vary line to line so the run boundaries are not themselves on a
    // fixed stride, and the index stays readable for locating a diff.
    parts.push(
      "🝮".repeat(40 + (index % 13)) +
      "✦".repeat(index % 5) +
      `Ωμέγα${index}` +
      "🝮".repeat(20 + (index % 7)) +
      "\r\n",
    );
  }
  return parts.join("");
}

/**
 * Write the fixture vault to disk.
 *
 * The content is chosen so the projection has something to lose: a resolving
 * wikilink, an alias, an embed, a heading subpath, a link that must stay
 * unresolved, an external link, a filename with a space, non-ASCII note text,
 * a CRLF note that produces a parser diagnostic, a note larger than one pipe
 * chunk, two attachments sharing one content address, and two different
 * content types.
 */
export async function buildProofVault(root: string): Promise<void> {
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "assets/diagram.png"), PNG_BYTES);
  await writeFile(join(root, "assets/copy of diagram.png"), PNG_BYTES);
  await writeFile(join(root, "assets/report.pdf"), PDF_BYTES);
  await writeFile(
    join(root, "Index.md"),
    "# Index\n\n" +
    "See [[Decision]] and ![[assets/diagram.png]].\n" +
    "Also [[Choice]], [[Deep note]] and [[Nothing Here]].\n" +
    "External: [[https://example.com/page]].\n" +
    "Subpath: [[Decision#Decision]].\n",
    "utf8",
  );
  await writeFile(
    join(root, "notes/Decision.md"),
    "---\naliases: [Choice]\ntags: [proof, catalog]\n---\n\n" +
    "# Decision\n\nBack to [[Index]]. Mentions plesiosaur.\n\n## Detail\n\nA list:\n\n- one ^item-one\n- two\n",
    "utf8",
  );
  // CRLF on purpose: it produces a per-note `crlf-headings` diagnostic and
  // drops `headingsCertain`, both of which the projection compares. A restore
  // that normalized line endings would change the note's parse, not just its
  // bytes, and would fail here rather than pass quietly.
  await writeFile(
    join(root, "notes/Deep note.md"),
    "# Deep note\r\n\r\nUnicode: café — naïve 日本語 🜚.\r\nBack to [[Index]].\r\n",
    "utf8",
  );
  await writeFile(join(root, "notes/Wide note.md"), buildWideNoteText(), "utf8");
}

/**
 * The queries projected on both sides.
 *
 * Every target here is a question whose *answer* matters, including the ones
 * that must come back unresolved: a restore that turned a missing link into a
 * resolved one, or lost an external classification, would be just as wrong as
 * one that lost a note.
 */
export const PROOF_PROJECTION: QueryProjectionOptions = Object.freeze({
  searchQueries: Object.freeze([
    "plesiosaur",
    "PLESIOSAUR",
    "Index",
    "café",
    "日本語",
    "assets/diagram.png",
    "no-such-term-anywhere",
    "",
  ]),
  resolveTargets: Object.freeze([
    { from: "Index.md", target: "Decision" },
    { from: "Index.md", target: "notes/Decision.md" },
    { from: "Index.md", target: "Choice" },
    { from: "Index.md", target: "DECISION" },
    { from: "Index.md", target: "Deep note" },
    { from: "Index.md", target: "assets/diagram.png" },
    { from: "Index.md", target: "assets/copy of diagram.png" },
    { from: "Index.md", target: "assets/report.pdf" },
    { from: "Index.md", target: "Nothing Here" },
    { from: "Index.md", target: "Decision#Decision" },
    { from: "Index.md", target: "Decision#Missing Heading" },
    { from: "Index.md", target: "Decision#^item-one" },
    { from: "Index.md", target: "https://example.com/page" },
    { from: "Index.md", target: "/absolute.md" },
    { from: "Index.md", target: "../escape.md" },
    { from: "notes/Decision.md", target: "Index" },
    { from: "notes/Deep note.md", target: "Index" },
    { from: "Index.md", target: "Wide note" },
    { from: "notes/Wide note.md", target: "Index" },
    { from: "Absent.md", target: "Index" },
  ]),
});

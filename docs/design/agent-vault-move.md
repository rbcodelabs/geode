# Vault move/rename with link updating (agent-facing)

Status: implemented in Geode; the Agent Threads tool wrapper below is a **proposal only** (that repo is not touched here).

## API

```ts
App.moveVaultPath(from: string, to: string): Promise<{
  moved: { from: string; to: string }[];   // the requested move (one entry; a folder is one entry)
  updatedNotes: string[];                   // vault paths AFTER the move of notes whose content was rewritten
}>
app.fileManager.moveWithLinkUpdate(path, newPath)   // same result; plugin-visible
app.fileManager.renameFile(fileOrFolder, newPath)   // Obsidian-compatible, returns void, now link-updating for folders too
```

`moveVaultPath` is the single code path behind: file-explorer drag/drop, the rename prompts (file and folder),
`renameFileWithLinkUpdate`, `FileManager.renameFile`, and `FileManager.moveWithLinkUpdate`.
The plugin receives the real `App` instance (no proxy/allowlist), so `app.fileManager.moveWithLinkUpdate` is reachable as-is.

Pure planning lives in `src/renderer/link-move.ts` (`assertValidMove`, `collectMoves`, `planLinkRewrites`); I/O in `App.moveVaultPath`.

## Validation (all before the first write)

- Both paths: non-empty string, vault-relative. Rejected: leading `/`, drive prefix (`C:`), backslash, control chars,
  trailing `/`, empty segments (`a//b`), any `.` or `..` segment, any dot-prefixed (hidden) segment.
- `from === to` and moving a folder into itself/a descendant are rejected.
- Source must exist in the vault index.
- Target must not exist in the index **or** on disk (`vault.adapter.exists`, so case-insensitive filesystems are covered).
  A case-only rename (`a.md` -> `A.md`) is therefore refused on a case-insensitive filesystem.
- No ancestor of the target may be a file. Missing ancestor folders are created.
- If any affected open note (moved or rewritten) is in conflict read-only recovery state, the move is refused.
- Every rewrite is computed from current note text before the first write. Writes then run as: create parents, one
  `vault.rename`, then `vault.modify` per rewritten note. A failure partway through the modify phase is not rolled back.

## Link rewriting

A link is rewritten only if it resolved to a file before the move and its authored text no longer resolves to that file after it.
Links that still resolve (e.g. a bare `[[Note]]` that stays unique, links between two notes in the same moved folder) are
left byte-identical.

- `[[wikilinks]]` and `![[embeds]]`: alias, `#heading`, `#^block` suffixes preserved. A basename-style link stays a basename
  (new basename if the name changed) unless that no longer resolves uniquely, then it becomes the full vault path; path-qualified
  links become the new full path. `.md` extension kept only if the author wrote it.
- Markdown links/images `[t](rel/or/root/path.md#frag)`, `<angle form>`, and `%20`-encoded form (style preserved). Relative links
  stay relative (`./` kept when written), root-relative stay root-relative. External URLs, `#anchor`-only and `mailto:` are skipped.
- Reference definitions `[id]: path.md` are rewritten the same way.
- Relative markdown links **inside moved notes** pointing at notes that did not move are recomputed.
- Code fences and inline code are never touched.
- Only notes that can mention a moved file (by cached link target name) plus the moved notes themselves are read.

Not handled: Canvas `file` nodes, Bases, frontmatter-only YAML link strings other than `[[...]]` text, aliases-based wikilinks.

## `getBacklinksForFile`

`metadataCache.getBacklinksForFile(file)` returns `{ data: Map<sourcePath, Reference[]>, get(key), keys() }` where each reference has
`link`, `original` (authored text), `displayText`, `position`. Includes embeds and markdown links; its source set is exactly
`getBacklinks(file)` (which includes a note's links to itself). `LinkCache.original` is new; `METADATA_PARSER_VERSION` was bumped to 3
so persisted caches are re-parsed.

## Proposed Agent Threads tool (agent-threads/src/tools/vault.ts, next to `boundGetBacklinks`)

```ts
const moveSchema = {
  from: z.string().describe('Vault-relative path of the file or folder to move/rename'),
  to: z.string().describe('Vault-relative destination path (must not exist; parent folders are created)'),
};

const boundMovePath = tool(
  'obsidian_move_path',
  'Moves or renames a file or folder and updates wikilinks, embeds and markdown links in other notes. Refuses to overwrite. Returns the moved path and the notes whose content was rewritten.',
  moveSchema,
  async (args, _extra) => {
    try {
      type MoveResult = { moved: { from: string; to: string }[]; updatedNotes: string[] };
      const fileManager = app.fileManager as unknown as {
        moveWithLinkUpdate?: (path: string, newPath: string) => Promise<MoveResult>;
      };
      if (typeof fileManager.moveWithLinkUpdate !== 'function') {
        return { content: [{ type: 'text' as const, text: 'Error: this host does not support link-updating moves' }], isError: true };
      }
      // Do NOT normalizePath() here: Geode validates strictly and rejects "..", absolute and backslash paths itself.
      const result = await fileManager.moveWithLinkUpdate(args.from, args.to);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);
```

Register it with the other vault tools under the `vault_move` / `obsidian_move_path` alias pair the repo already uses for its tools.
Real Obsidian lacks `moveWithLinkUpdate`; there, fall back to `app.fileManager.renameFile(abstractFile, to)` (which updates links, but
returns no list) for compatibility.

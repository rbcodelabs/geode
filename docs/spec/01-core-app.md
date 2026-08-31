# Core App Specification

Source of truth for cloning Obsidian's core application features. Reverse-engineered from the official documentation at https://help.obsidian.md (canonical host: https://obsidian.md/help/), fetched 2026-06-10.

Scope: vaults, files/folders, editor, Obsidian Flavored Markdown, properties, linking, search, workspace, command palette, quick switcher, hotkeys, settings, appearance, note composer, file recovery, format converter, help/sandbox. Excludes paid services (Sync, Publish), Canvas, Bases, Web Clipper, and the plugin API (covered in later specs).

---

## 1. Product Overview

- Obsidian is "a Markdown editor and a knowledge base app." Local-first: all data is stored as Markdown-formatted plain-text files on disk, never required to be in the cloud.
- Notes can be edited by external editors/file managers; the app watches the filesystem and refreshes automatically to reflect external changes.
- Philosophy: links between notes are first-class; the app is a foundation of optional building blocks (core plugins) rather than one opinionated workflow.
- Customizable via CSS snippets, community themes, and community plugins.

### Data storage
- A **vault** = a folder on the local filesystem, including all subfolders.
- Each vault contains a hidden `.obsidian` configuration folder at its root holding vault-specific settings: hotkeys, themes, community plugins, CSS snippets, and workspace state (`workspace.json`, `workspaces.json` — these change frequently; users often gitignore them).
- **Global (per-device) settings** locations:
  - macOS: `~/Library/Application Support/obsidian`
  - Windows: `%APPDATA%\Obsidian\`
  - Linux: `$XDG_CONFIG_HOME/obsidian/` or `~/.config/obsidian/`
- Metadata cache: IndexedDB-backed cache of file metadata (powers Graph view, Outline, link resolution); persists across app restarts.

---

## 2. Vaults

### Concept
- A vault is a folder containing notes, attachments, and the `.obsidian` config folder.
- Vault-level configuration lives in `.obsidian`; copying that folder into another vault root (then restarting) transfers settings between vaults.

### Vault switcher ("Manage vaults")
- Opens automatically on first launch (first-run experience).
- Access from a vault: **Vault profile** icon at the bottom-left of the sidebar (chevrons-up-down icon), or Command palette → "Open another vault".
- Operations from the vault switcher:
  - **Create new vault**: name + Browse to pick parent location + Create.
  - **Open folder as vault**: pick any existing folder.
  - **Open vault from Obsidian Sync** (remote vault — out of scope for core).
  - Per-vault **More options** (…) menu: **Rename vault** (renames the underlying folder), **Move vault**, **Remove from list**.
- **Removing a vault only removes it from the vault list** — the folder stays on disk.
- Moving a vault manually (close app, move folder, re-open via "Open folder as vault") is supported; community plugins must be re-enabled afterwards (restricted mode prompt).

#### Current Geode behavior

Geode opens the first usable recent vault on normal startup and shows its vault picker when no recent vault exists. From an open vault, the bottom-left **Manage vaults** action and Command palette → **Open another vault** open a list of the current and recent vaults plus **Open folder as vault**. A different vault opens in its own top-level window; choosing a vault that is already open restores and focuses that window. Create, rename, move, remove-from-list, and multi-window restoration after a full app restart are not implemented.

### Configuration folder override
- Settings → Files and Links → **Override config folder**: use a different dotfolder name (e.g. `.obsidian-awesome`) as the vault's config profile; requires relaunch. Old config folder remains; settings do not auto-migrate.

---

## 3. Files & Folders

### Accepted file formats (natively supported)
- Markdown: `.md`
- Canvas: `.canvas` (JSON Canvas)
- Database: `.base`
- Images: `.avif`, `.bmp`, `.gif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.webp`
- Audio: `.flac`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.webm`, `.3gp`
- Video: `.mkv`, `.mov`, `.mp4`, `.ogv`, `.webm`
- PDF: `.pdf`
- Audio/video playback depends on device codecs. Other formats can be added by community plugins.

### Note operations
- **Create**: `Ctrl/Cmd+N`, file explorer "New note" button, or Command palette. Type name, Enter, start editing.
- Filename restrictions follow the OS; cross-device users should keep names safe for all operating systems. Characters invalid in linkable filenames: `# | ^ : %% [[ ]]`.
- **Rename**: click the note title (inline title) or press `F2`; or rename from file explorer without opening. All internal links to the file update automatically (when "Automatically update internal links" is on).
- **Delete**: note More options menu → Delete file; Command palette → "Delete current file"; or file explorer context menu (with confirmation prompt).
- **Deleted-file destination** (Settings → Files & Links → Trash):
  - **System trash** (default) — OS trash, recoverable.
  - **Obsidian trash** — `.trash` folder inside the vault.
  - **Permanently delete** — no recovery.
  - "Confirm file deletion" toggle.
- **Default location for new notes** (Settings → Files & Links): vault root, same folder as current file, or a specified folder.

### File explorer (core plugin)
- Tree view of all files/folders in the vault (left sidebar tab).
- Top toolbar: **New note**, **New folder**, **Change sort order**, **Expand all / Collapse all**, **Auto-reveal active file** toggle (scrolls to and highlights the open note).
- Sort orders: file name, modified time, created time — each ascending/descending.
- Context menu: New note (in folder), New folder (subfolder), Rename, Delete, "Move file to…" (search-and-pick destination), "Merge entire file with…" (Note composer), Open in new window, etc.
- Multi-select: `Alt`-click (Win/Linux) / `Opt`-click (macOS) for individual files; `Shift`-click for ranges; selections can be dragged together.
- "Show all file types" setting (Files & Links) reveals unrecognized extensions in the explorer.
- **Excluded files** setting (Files & Links → Advanced): path/filter patterns; excluded files are hidden or deprioritized in search, quick switcher, unlinked mentions, etc.

### Drag and drop
- Drag sources: file explorer items, search results, backlink/unlinked-mention results, links inside notes (reading view).
- Drop targets:
  - **Tab header / tab group** → opens the file there (hold `Alt`, or `Shift` on macOS, to drop anywhere in a tab group rather than only on headers).
  - **Folder** in explorer → moves the file.
  - **Editor** → inserts a link to the file (respects wikilink/markdown link preference).
  - **Bookmarks tab** → bookmarks the file.
- From outside the app:
  - HTML dragged from a browser is converted to Markdown.
  - Native files are copied into the vault (attachment folder rules) and linked. Hold `Ctrl` (Win/Linux) / `Option` (macOS) while dropping to create an absolute `file:///` link instead of importing.
- Dragging a note out of Obsidian to another app yields an `obsidian://` URL.

### Attachments
- Added by copy/paste into the editor, drag-and-drop, or saving files directly into the vault. Pasted/dropped files are copied to the default attachment location and embedded automatically.
- **Default location for new attachments** (Settings → Files & Links), four options:
  1. Vault folder (root)
  2. In the folder specified below (fixed folder)
  3. Same folder as current file
  4. In subfolder under current folder (subfolder created on demand)
- Attachments are plain files, accessible through the OS file system.

---

## 4. Editor

### Views and modes
- **Reading view**: rendered output, no Markdown syntax visible; read-only presentation.
- **Editing view**, with two modes:
  - **Live Preview** (default): formatted text rendered inline; the raw Markdown syntax is revealed for the element under the cursor/selection.
  - **Source mode**: raw Markdown exactly as written.
- Switching:
  - View switcher icon in the tab's upper-right corner; `Ctrl/Cmd`-click it to open Reading + Editing side by side (linked).
  - Status bar mode indicator (clickable; choose Reading view / Live Preview / Source mode).
  - `Ctrl/Cmd+E` = "Toggle Reading view".
  - Command "Toggle Live Preview/Source mode" (assignable hotkey).
- Defaults (Settings → Editor): "Default view for new tabs" (Reading or Editing); "Default editing mode" (Live Preview or Source mode); "Focus new tabs"; status-bar editing-mode indicator toggle.

### Editing features
- **Multiple cursors**: `Alt/Opt`+click adds a cursor; click without modifier or `Escape` clears extras. Rectangular (column) selection: `Shift+Alt` (`Shift+Option` on macOS) + drag, or middle-mouse drag.
- **Folding**: fold headings and indented lists via the chevron in the gutter (fold arrows persist when folded). Settings → Editor: "Fold heading" and "Fold indent" toggles. Commands: "Fold all headings and lists", "Unfold all headings and lists", "Fold more", "Fold less".
- **Spellcheck** (Settings → Editor → Behavior): toggle, custom dictionary management, spellcheck language selection.
- **Vim key bindings** (Settings → Editor → Behavior): optional modal editing.
- **Auto-pair brackets** and **auto-pair Markdown syntax**; **Smart lists** (auto-continue list markers); Tab vs spaces indentation + visual indent width; line numbers; indentation guides; readable line length (max line width); RTL text direction; "Convert pasted HTML to Markdown"; strict line breaks toggle; properties display mode.
- **Editing shortcuts** (defaults; not remappable text-editing primitives):

  Windows/Linux: Copy `Ctrl+C`, Cut `Ctrl+X`, Paste `Ctrl+V`, Paste without formatting `Ctrl+Shift+V`, Undo `Ctrl+Z`, Redo `Ctrl+Shift+Z`/`Ctrl+Y`; copy/cut with no selection acts on the paragraph; Delete line `Ctrl+Shift+K`; delete prev/next word `Ctrl+Backspace`/`Ctrl+Delete`; navigation `Home/End`, `Ctrl+Home/End` (note start/end), `Ctrl+←/→` (word), `PageUp/PageDown`; selection = same + `Shift`; `Escape` simplifies selection; `Ctrl+A` select all.

  macOS: `Cmd` equivalents; Bold `Cmd+B`, Italic `Cmd+I`; delete word `Opt+Backspace`/`Opt+Delete`; delete to line start/end `Cmd+Backspace`/`Cmd+Delete`; line start/end `Cmd+←/→`; word `Opt+←/→`; note start/end `Cmd+↑/↓`; page `Fn+↑/↓`; selection variants with `Shift`.

### Mobile editor
- **Mobile toolbar** (formatting toolbar) appears above the keyboard while editing; horizontally scrollable when crowded; customizable (add/remove/reorder actions; add any global command) via the wrench icon or Settings → Mobile → Manage toolbar options.
- **Navigation bar** (bottom, when not editing): back/forward, create/find note (Quick switcher), tab counter, "Open menu" (replaces the ribbon).
- **Quick Action**: pull-down-from-top gesture runs one configurable command (default: Command palette).
- Sidebars open via left/right swipe gestures.

---

## 5. Obsidian Flavored Markdown

Baseline: CommonMark + GitHub Flavored Markdown + LaTeX, plus Obsidian extensions. Markdown is deliberately **not** rendered inside HTML tags (`<div>`, `<span>`, `<table>`, …).

Obsidian-specific extension summary:

| Syntax | Feature |
|---|---|
| `[[Link]]` | Internal (wiki)link |
| `![[Link]]` | Embed |
| `![[Link#^id]]` | Block reference embed |
| `^id` | Block definition |
| `[^id]` | Footnote |
| `%%Text%%` | Comment (editing view only) |
| `~~Text~~` | Strikethrough |
| `==Text==` | Highlight |
| `> [!note]` | Callout |
| `- [ ]` / `- [x]` | Task list |

### Paragraphs & line breaks
- Blank line separates paragraphs. Multiple spaces collapse in reading view (use `&nbsp;` or `<br>` to force).
- Line break inside a paragraph: two trailing spaces + Enter, or `Shift+Enter`.
- **Strict line breaks** setting: when on, single newlines join lines (CommonMark behavior); 2+ trailing spaces produce `<br>`; double newline produces separate `<p>`.

### Headings
`#` through `######` for H1–H6.

### Text styling
| Style | Syntax |
|---|---|
| Bold | `**text**` or `__text__` |
| Italic | `*text*` or `_text_` |
| Bold+italic | `***text***` or `___text___` |
| Bold w/ nested italic | `**Bold and _nested italic_**` |
| Strikethrough | `~~text~~` |
| Highlight | `==text==` |

### Links
- External: `[Obsidian Help](https://help.obsidian.md)`; URLs with spaces: `%20`-encode or wrap in `<…>`.
- External image: `![alt](https://example.com/img.jpg)`, with size: `![alt|640x480](url)` or `![alt|100](url)`.
- Obsidian URI links: `[Note](obsidian://open?vault=MainVault&file=Note.md)`.

### Quotes
`> quoted text`; becomes a callout if the first line is `[!type]`.

### Lists
- Unordered: `-`, `*`, or `+`.
- Ordered: `1.` or `1)`.
- Nesting by indentation; `Tab`/`Shift+Tab` to indent/outdent; mixed list types allowed.
- Task lists: `- [ ]` incomplete, `- [x]` complete; **any** character in the brackets (`[?]`, `[-]`, …) renders as completed/checked-style.

### Horizontal rules
Three or more `***`, `---`, or `___` (spaces between characters allowed).

### Code
- Inline: `` `code` ``; to include backticks, use double-backtick delimiters.
- Fenced blocks: triple backticks with optional language for syntax highlighting (Prism-based). Indented blocks (4 spaces / tab) also work.
- Nesting fences: outer fence uses 4+ backticks/tildes.

### Footnotes
```md
Simple footnote[^1]. Named footnote[^note].

[^1]: Referenced text.
[^note]: Named footnotes render as numbers.
```
- Inline footnotes: `^[This is an inline footnote.]` (renders in reading view only).
- A **Footnotes view** core plugin lists the current note's footnotes in the sidebar.

### Comments
`%%inline comment%%` and multi-line `%% … %%` blocks — visible only in editing view, stripped in reading view.

### Escaping
Backslash-escape: `\*`, `\_`, `\#`, `` \` ``, `\|`, `\~`. Escape an accidental ordered list with `1\.`.

### Tables
```md
| First name | Last name |
| ---------- | --------- |
| Max        | Planck    |
```
- Alignment row: `:--` left, `:--:` center, `--:` right.
- Inside tables, escape pipes in wikilinks/image sizes: `[[Page\|Alias]]`, `![[img.jpg\|200]]`.

### Math (MathJax / LaTeX)
- Block: `$$ … $$` (multi-line allowed) — e.g. `$$\begin{vmatrix}a & b\\ c & d\end{vmatrix}=ad-bc$$`
- Inline: `$e^{2i\pi} = 1$`

### Diagrams
- ` ```mermaid ` code blocks render Mermaid diagrams (sequence diagrams, flowcharts, etc).
- Internal links inside diagrams: `class NodeA,NodeB internal-link;`

### Callouts
- Syntax: blockquote whose first line is `> [!type]`, body in following `>` lines.
- Custom title: `> [!tip] Callouts can have custom titles`. Title-only callouts allowed (no body). Default title = type identifier in Title Case.
- Body supports Markdown, wikilinks, embeds.
- Foldable: `> [!faq]-` collapsed by default, `> [!faq]+` expanded by default (clickable fold).
- Nesting: `> [!a]` containing `> > [!b]` containing `> > > [!c]`.
- Type identifiers are case-insensitive; unknown types render as `note`.
- Built-in types and aliases:
  | Type | Aliases |
  |---|---|
  | `note` | — |
  | `abstract` | `summary`, `tldr` |
  | `info` | — |
  | `todo` | — |
  | `tip` | `hint`, `important` |
  | `success` | `check`, `done` |
  | `question` | `help`, `faq` |
  | `warning` | `caution`, `attention` |
  | `failure` | `fail`, `missing` |
  | `danger` | `error` |
  | `bug` | — |
  | `example` | — |
  | `quote` | `cite` |
- Custom types via CSS: `.callout[data-callout="custom"] { --callout-color: R, G, B; --callout-icon: lucide-icon-id; }`.

### Tags (inline syntax)
- `#tag` anywhere in body text. Must contain at least one non-numeric character (`#1984` invalid, `#y1984` valid).
- Allowed characters: letters, digits, `_`, `-`, `/` (nesting), plus Unicode/emoji. No spaces — use `#camelCase`, `#PascalCase`, `#snake_case`, `#kebab-case`.
- Nested tags: `#inbox/to-read`; searching/filtering `tag:inbox` matches all descendants.
- Case-insensitive matching; displayed with first-created casing in the Tags view.
- Clicking a tag opens search for it. **Tags view** core plugin lists all vault tags with counts.

### HTML
- Inline HTML is allowed, but Markdown inside HTML elements is not processed.

---

## 6. Properties (YAML frontmatter)

### Format
- YAML block at the very top of the file between `---` delimiters; `name: value` (colon + space). Property names unique per note.
- JSON frontmatter is also accepted but is read/interpreted/re-saved as YAML.
- Not supported: nested properties, bulk editing in-app, Markdown rendering inside property values.

### Adding properties
- Command "Add file property"; hotkey `Ctrl/Cmd+;`; note More-actions menu → Add file property; or type `---` on the first line.

### Property types
| Type | Notes |
|---|---|
| Text | single line; URLs and internal links supported (links must be quoted: `"[[Note]]"`) |
| List | multiple values, `- item` per line |
| Number | literal numbers only (int/decimal; no expressions) |
| Checkbox | `true` / `false` (or indeterminate when unset) |
| Date | `2020-08-21` (display follows OS locale) |
| Date & time | `2020-08-21T10:30:00` |

### Default/special properties
- `tags` (list), `aliases` (list), `cssclasses` (list — applies CSS classes to the note's container).
- Publish-related: `publish`, `permalink`, `description`, `image`, `cover`.
- Deprecated singular forms `tag`, `alias`, `cssclass` (removed in v1.9; Format converter migrates them).

### Property editor UI
- Rendered as a typed key/value editor above the note content in Live Preview/Reading view, with type icons, value autocomplete (e.g. existing tags), and add/remove controls.
- Display setting (Settings → Editor → "Properties in document"): **Visible** (default), **Hidden**, **Source** (raw YAML).
- Keyboard: add property `Cmd/Ctrl+;`, delete property `Cmd/Ctrl+Backspace`, next/prev field `Tab`/`Shift+Tab` or arrows, jump into editor `Alt+Down`.

### Properties view (core plugin)
- **File properties** sidebar view: properties of the active note.
- **All properties** sidebar view: every property in the vault; sortable by name or frequency; click a property to launch a property search; right-click → rename property across the entire vault.

### Aliases
- Defined via the `aliases` list property.
- Link autocomplete matches aliases and shows them with a curved-arrow icon; selecting one inserts `[[Actual Note|Alias]]`.
- Aliases participate in unlinked-mention detection (Backlinks pane) and Quick switcher matching; converting an aliased unlinked mention creates `[[Note|alias-text]]`.

---

## 7. Linking

### Internal link syntax
- Wikilink: `[[Three laws of motion]]` (extension optional for `.md`; required for non-Markdown files, e.g. `[[Figure 1.png]]`).
- Markdown link equivalent: `[Three laws of motion](Three%20laws%20of%20motion.md)` (URL-encoded).
- Display text: `[[Note|Custom display]]` / `[Custom display](Note.md)`.

### Heading links
- Same note: `[[#Heading]]`; other note: `[[Note#Heading]]`; subheading chains: `[[Note#Heading#Subheading]]`.
- Vault-wide heading search in autocomplete: type `[[##` + term.

### Block links
- `[[Note#^37066d]]` — auto-generated 6-char block ID appended to the target block as `^37066d`.
- Custom human-readable IDs: `^quote-of-the-day` (Latin letters, digits, dashes); structured blocks (lists, quotes, tables, callouts) need the `^id` on its own line surrounded by blank lines.
- Vault-wide block search in autocomplete: `[[^^` + term.
- Block references are an Obsidian-only extension (not portable Markdown).

### Autocomplete & creation
- Typing `[[` triggers the link suggester (notes, aliases, headings with `#`, blocks with `^`).
- Select text then type `[[` to wrap the selection into a link; command "Add internal link".
- Linking to a non-existent note creates an "unresolved" link; opening it creates the note.

### Settings (Files & Links)
- **New link format**: shortest path when possible / relative path / absolute path in vault.
- **Use [[Wikilinks]]** toggle — off = generate standard Markdown links.
- **Automatically update internal links** on file rename/move.

### Embeds
- Embed any file: `![[filename]]`.
- Note: `![[Internal links]]`; heading section: `![[Internal links#Link to a heading]]`; block: `![[Internal links#^b15695]]`.
- Image: `![[Engelbart.jpg]]`; sized `![[Engelbart.jpg|640x480]]`; width-only `![[Engelbart.jpg|100]]` (proportional). External image with size: `![250](https://example.com/image.jpg)`.
- Audio: `![[Recording.ogg]]` (inline player). Video: same `![[movie.mp4]]` pattern (player; codec-dependent).
- PDF: `![[Document.pdf]]`; specific page `![[Document.pdf#page=3]]`; viewer height `![[Document.pdf#height=400]]`.
- Canvas: `![[My canvas.canvas]]` (shapes render, card text doesn't).
- List block embed: tag the list with `^my-list-id`, then `![[My note#^my-list-id]]`.
- Search results: embedded ` ```query ` blocks (see §8).

### Backlinks (core plugin)
- Right-sidebar tab for the active note with two collapsible sections:
  - **Linked mentions** — notes containing internal links to this note.
  - **Unlinked mentions** — plain-text occurrences of the note's name (or aliases); each row has a **Link** button to convert the mention into a real link. Excluded files don't appear.
- View controls: Collapse results, Show more context, Change sort order, Show search filter (filter mentions by term).
- "Backlinks in document": command "Toggle backlinks in document" or per-plugin setting renders a backlinks section at the bottom of every note.
- "Open backlinks for the current note" opens a standalone, persistent backlinks tab for a specific note.

### Outgoing links (core plugin)
- Right-sidebar tab, inverse of backlinks:
  - **Links** — all links in the active note (click to open).
  - **Unlinked mentions** — text in this note matching names/aliases of other notes, with one-click linking; hovering shows full path when names are ambiguous; excluded files omitted.

### Page preview (core plugin)
- Hovering a link (with `Ctrl/Cmd` by default) shows a popover preview of the target note.

---

## 8. Search

### Search view (core plugin)
- Left-sidebar tab; hotkey `Ctrl/Cmd+Shift+F` ("Search: Search in all files"). Opening with text selected pre-fills the query. Empty query shows recent searches.

### Term syntax
- Space-separated terms = implicit AND: `meeting work`.
- `OR`: `meeting OR work`.
- Negation: `-work`, `-(work meetup)`.
- Grouping: `meeting (work OR meetup) personal`.
- Exact phrase: `"star wars"`; escaped quotes inside phrases: `"they said \"hello\""`.
- Regex: `/\d{4}-\d{2}-\d{2}/` (JavaScript flavor); combinable with operators (`path:/\d{4}-\d{2}-\d{2}/`).

### Operators
| Operator | Meaning | Example |
|---|---|---|
| `file:` | match file name | `file:.jpg`, `file:202209` |
| `path:` | match file path | `path:"Daily notes/2022-07"` |
| `content:` | match file content | `content:"happy cat"` |
| `match-case:` | force case-sensitive | `match-case:HappyCat` |
| `ignore-case:` | force case-insensitive | `ignore-case:ikea` |
| `tag:` | match tag (skips code blocks; includes nested tags) | `tag:#work`, `tag:inbox` |
| `line:(…)` | terms must share a line; negatable `-line:` | `line:(mix flour)` |
| `block:(…)` | terms must share a block | `block:(dog cat)` |
| `section:(…)` | terms must share a section (between headings) | `section:(dog cat)` |
| `task:` | match inside any task | `task:call` |
| `task-todo:` | match in unchecked tasks | `task-todo:call` |
| `task-done:` | match in checked tasks | `task-done:call` |

### Property search
- `[property]` — files having the property.
- `[property:value]` — property equals/contains value: `[status:Draft]`.
- `[property:null]` — property empty/absent value.
- Sub-queries inside the value: `[status:Draft OR Published]`, quotes and regex allowed.
- Comparison operators in bracketed queries: `[duration:<5]`, `[duration:>5]`.

### UI features
- **Match case** toggle button (default insensitive).
- Settings (gear icon): **Explain search term** (natural-language breakdown of the query), **Collapse results**, **Show more context**.
- **Sort order**: file name A→Z (default) / Z→A, modified time (new/old), created time (new/old).
- **Copy search results** (… menu) — copies results list (with link-style options).
- Excluded files are filtered/deprioritized in results.

### Embedded queries
Render live search results inside a note:

````md
```query
embed OR search
```
````

---

## 9. Workspace & Window Management

### Layout regions (desktop)
- **Ribbon**: vertical icon toolbar on the far left. Defaults include vault switcher/profile, help, settings + plugin-contributed actions (Quick switcher, Graph, Canvas, Daily note…). Drag to reorder; right-click empty area to hide individual actions or the whole ribbon; Settings → Appearance → Advanced → "Show ribbon". Ribbon layout syncs via workspace config.
- **Left & right sidebars (docks)**: hold plugin tabs (File explorer, Search, Bookmarks on the left; Backlinks, Outgoing links, Tags, Outline, Properties on the right, by convention). Collapsible (per-side toggle icons / commands), resizable, vertically splittable into multiple tab groups; tabs can be dragged between groups, into the main area, and notes can be dragged into a sidebar to keep them visible.
- **Main area**: tab groups, splittable horizontally and vertically without limit.
- **Status bar** (bottom-right): per-file/system info — backlink count, current editing mode, word & character count (Word count plugin); plugin items may be interactive (e.g. Sync status/log). Core and community plugins can add items.

Geode implements built-in and plugin views as the same movable workspace-leaf
type. Sidebar top/bottom drop targets create vertically stacked tab groups with
resizable dividers. Layout persistence uses a versioned recursive split/tab
tree and migrates the prior flat version-1 format. Obsidian-compatible
`getLeftLeaf(true)` / `getRightLeaf(true)` calls create a new sidebar group;
passing `false` reuses an available leaf in the default group.

A saved leaf whose view type cannot be resolved at restore time is **never
discarded**. If the plugin providing it is disabled, quarantined, mid-update,
suppressed by crash recovery, or simply slower to load than the plugin onload
budget, the leaf is restored as a labelled placeholder that keeps the saved
`type` and `state` through further save cycles, and hydrates into the real view
as soon as the provider registers. Built-in view types (File explorer, Search,
Backlinks, Outline, Tags, Bookmarks) are never turned into placeholders — they
are constructed at startup and matched by leaf identity, so a placeholder for
one would be a permanent duplicate. Layout saves are suppressed entirely while
the app is in plugin-free crash-recovery mode, so a recovery launch cannot
overwrite the real layout. See `docs/adr/0005-deferred-view-restore.md`.

### Tabs
- New tab: `Ctrl/Cmd+T` or "+" button. Close: `Ctrl/Cmd+W`. Reopen closed: `Ctrl/Cmd+Shift+T`.
- Open links: click = active tab; `Ctrl/Cmd`+click = new tab; `Ctrl/Cmd+Alt`+click = new tab group (split); `Ctrl/Cmd+Alt+Shift`+click = new window. (Source mode adds `Shift` to the modifier combos.)
- Navigation: next/prev tab `Ctrl+Tab` / `Ctrl+Shift+Tab`; jump to tab N `Ctrl/Cmd+1…8`; last tab `Ctrl/Cmd+9`.
- Drag to reorder tabs, drag between groups/windows, drag to a group edge to create a split.
- Context menu: Split right / Split down, Pin, Open in new window, Move to new window, Close, Close others, etc.
- **Pinned tabs**: pinned tabs never navigate away — links open elsewhere. Pinned sidebar panes (e.g. Backlinks) stay focused on the last note.
- **Stacked tabs**: per tab group toggle ("Stack tabs") — tabs render as sliding cards stacked side-by-side (Andy Matuschak mode).
- **Linked views**: tab More options → "Open linked view" → Graph / Backlinks / Outline (or linked Reading view); linked tabs scroll/update with their source tab.

### Splits & resizing
- Split any tab group right (vertical divider) or down (horizontal divider); resize by dragging highlighted group edges.

### Pop-out windows (desktop only)
- Open a note or tab in a separate OS window: file explorer right-click → "Open in new window"; Command palette → "Open current tab in new window" / "Move current tab to new window"; tab context menu; right-click a link.
- Move tabs between windows by dragging or via commands. Windows belong to their vault — closing the vault window closes its pop-outs; tabs can only move between windows of the same vault.

### Workspaces (core plugin — saved layouts)
- Save/load/delete named layouts via ribbon button or command "Manage workspace layouts".
- A workspace stores open files/tabs, sidebar widths, and sidebar visibility.
- Saving with an existing name overwrites (update); deletion via "Delete layout" button.

---

## 10. Command Palette & Quick Switcher

### Command palette (core plugin)
- Open: `Ctrl/Cmd+P` or ribbon icon.
- Fuzzy matching ("scf" → "Save current file"); recently used commands float to the top (v1.8.3+), with shorter commands prioritized while filtering.
- Shows each command's assigned hotkey inline; arrow keys + Enter to run.
- **Pinned commands**: Settings → Command palette → "New pinned command" — pinned commands appear at the top of the empty palette; remove via X icon.

### Quick switcher (core plugin)
- Open: `Ctrl/Cmd+O`, ribbon button, or mobile create/find button.
- Type to fuzzy-match notes by name or alias; arrows + Enter to open; `Ctrl/Cmd+Enter` opens in a new tab; `Shift+Enter` creates a note with the exact typed name; Enter on a non-matching term creates a new note.
- Empty query shows recently opened notes (quick toggle between two notes).
- Excluded files are deprioritized. With ≥10,000 vault items the matcher falls back to a simpler algorithm for performance.
- Plugin options include showing existing files only / attachments / all file types (controls whether non-md and not-yet-created items appear).

---

## 11. Hotkeys

- Settings → **Hotkeys**: searchable list of every registered core and plugin command. Assign with the "+" icon and press a physical-key combination; changes apply immediately. Remove an individual assignment with its X button, use **Reset** to restore a command's declared defaults, and use **Assigned only** to show only commands with effective assignments.
- Multiple combinations per command are supported. When an exact combination belongs to another command, **Cancel** leaves every assignment unchanged and explicit **Reassign** removes it from every current owner before assigning it to the selected command. Malformed/manual duplicate ownership is highlighted and fails closed instead of choosing a command by registration order.
- Hotkeys display using US-keyboard labels but trigger by physical key pressed (layout-independent once assigned).
- Geode customizations apply live in the host workspace and embedded Web Viewer, and are stored per vault as override deltas in `.geode/hotkeys.json`. Obsidian uses `.obsidian/hotkeys.json`; importing that separate key-based schema is outside the native Geode hotkey manager.
- Browser/mobile hosts use the same physical-key event path when a hardware keyboard is present. Touch-only devices can inspect, remove, and reset assignments. Geode warns about shortcuts commonly reserved by the operating system or host because those events may never reach the app.
- Notable defaults (beyond OS text-editing): New note `Ctrl/Cmd+N`, Quick switcher `Ctrl/Cmd+O`, Command palette `Ctrl/Cmd+P`, Global search `Ctrl/Cmd+Shift+F`, Toggle reading view `Ctrl/Cmd+E`, New tab `Ctrl/Cmd+T`, Reopen closed tab `Ctrl/Cmd+Shift+T`, Add file property `Ctrl/Cmd+;`, Rename `F2`, Bold `Ctrl/Cmd+B`, Italic `Ctrl/Cmd+I`, tab cycling `Ctrl+Tab`/`Ctrl+Shift+Tab`, tab jump `Ctrl/Cmd+1…9`.

---

## 12. Settings Organization

Settings dialog is divided into **Options**, **Core plugins**, and **Community plugins** sections.

### General
- App version + update check, "Automatic updates" toggle, early-access/insider builds (Catalyst license).
- Interface language selection.
- Help resources; account sign-in (username/email/sign out); Catalyst & Commercial license activation; notices.

### Editor
- **Display**: readable line length; strict line breaks; properties in document (Visible/Hidden/Source); fold heading; fold indent; show line numbers; show indentation guides; RTL support.
- **Behavior**: spellcheck (+ custom dictionary, languages); auto-pair brackets; auto-pair Markdown syntax; smart lists; indent with tabs vs spaces + tab size; auto-convert HTML on paste; vim key bindings.
- **Tabs/views**: focus new tabs; default view for new tabs (Reading/Editing); default editing mode (Live Preview/Source); show editing-mode status-bar item.

### Files & Links
- Confirm file deletion; deleted-files destination (system trash / Obsidian trash / permanent).
- Default location for new notes; default location for new attachments (4 options).
- New link format (shortest / relative / absolute); use Wikilinks toggle; automatically update internal links.
- Detect all file extensions ("Show all file types").
- Excluded files (filters); Override config folder; URI callbacks; rebuild vault cache.

### Appearance
- Base color scheme: adapt to system / light / dark.
- Accent color picker.
- Themes: current theme, Manage (browse/install/update community themes).
- Fonts: interface font, text font (editor/reading), monospace font; font size slider + quick adjust (keyboard/trackpad).
- Interface: show inline title; show tab title bar; ribbon visibility & menu configuration.
- Advanced: zoom level; native menus; window frame style (Obsidian frame / native / hidden); custom app icon (`.icns/.ico/.png/.svg`); translucent window (macOS); hardware acceleration toggle.
- CSS snippets list: open snippets folder, reload, per-snippet toggles.

### Hotkeys
- Search/assign/remove keyboard shortcuts (see §11).

### Core plugins
- Toggle list of all built-in plugins; gear icon for per-plugin options; some are off by default.

### Community plugins
- Restricted mode toggle (disables third-party code); Browse/install/update community plugins; per-plugin enable toggles and options.

### Per-plugin option tabs
Enabled plugins with settings get their own tab under "Plugin options" (e.g. Command palette pinned commands, File recovery intervals, Note composer templates).

---

## 13. Appearance & Theming

- **Color scheme**: light, dark, or follow OS.
- **Accent color**: user-selectable; flows through UI via CSS variables.
- **Themes** (community): Settings → Appearance → Themes → Manage → browse → "Install and use". "Stop using this theme" reverts to default. Manual updates: per-theme "Check for updates" → Update, or "Check for updates → Update all" for bulk. Uninstall from the same manager. Themes are CSS packages stored in `.obsidian/themes/`.
- **CSS snippets**: `.css` files in `<config folder>/snippets/`. Enable via Settings → Appearance → CSS snippets (Open snippets folder / Reload snippets / per-snippet toggle). Changes to snippet files are detected and applied live on save. Styling hooks include CSS variables (e.g. `--h1-color`) and per-note classes via the `cssclasses` property.
- **Fonts & zoom**: interface/text/monospace font overrides, font-size slider, app-wide zoom level, quick font-size gestures.
- Window chrome: native vs custom frame, native menus, translucency (macOS), custom app icon, hardware acceleration.

---

## 14. Note Composer (core plugin)

- **Merge two notes**: file explorer right-click → "Merge entire file with…" or command "Note composer: Merge current file with another file…". Pick destination; `Enter` appends source at end, `Shift+Enter` prepends at start, `Ctrl/Cmd+Enter` merges into a brand-new note. The source note is deleted and **all links to it are redirected to the merged note**. Confirmation prompt by default; recoverable via File recovery.
- **Extract selection**: select text → right-click "Extract current selection…" or command. Same Enter/Shift+Enter/Ctrl+Enter placement choices.
- **Link handling setting**: after extraction, replace extracted text with a link to the destination (default), an embed, or nothing.
- **Template setting**: optional template file applied to merged/extracted content with variables `{{content}}`, `{{fromTitle}}`, `{{newTitle}}`, `{{date:FORMAT}}`.

---

## 15. File Recovery (core plugin)

- Automatic snapshots of modified files: default minimum interval 5 minutes, retained 7 days; both configurable (Settings → Core plugins → File recovery).
- Only `.md` and `.canvas` files are snapshotted.
- Snapshots are stored in **global settings outside the vault**, keyed by absolute path → device-local, not synced; moving a vault outside the vault switcher can orphan snapshots.
- Restore flow: Settings → File recovery → Snapshots → View → search by filename → pick snapshot → **Copy** (into a new note) or **Restore** (overwrite current file).
- **Show changes** toggle: diff view (additions/removals) between versions.
- **Clear history**: irreversibly deletes all snapshots (confirmation required).

---

## 16. Format Converter (core plugin)

- Vault-wide Markdown dialect converter (Command palette → "Open format converter", or ribbon icon). Warn users to back up first — it converts the entire vault per its toggles.
- Conversions:
  - Roam: `#tag` / `#[[tag]]` → `[[tag]]`; `^^highlight^^` → `==highlight==`; `{{[[TODO]]}}` → `[ ]`.
  - Bear: `::highlight::` → `==highlight==`.
  - Zettelkasten links: `[[UID]]` → `[[UID File Name]]` or pretty `[[UID File Name|File Name]]`.
  - Deprecated properties (v1.9.3+): `alias:`→`aliases:`, `tag:`→`tags:`, `cssclass:`→`cssclasses:` (all to list form).

---

## 17. Help, Onboarding & Sandbox

- **First run**: vault switcher opens; user creates or opens a vault.
- **Help** ribbon/sidebar icon: opens help resources (help site, docs are themselves an Obsidian vault published online; downloadable from the obsidian-help GitHub repo).
- **Sandbox vault**: built-in demo vault for safely exploring features and debugging (isolating whether a problem comes from plugins/themes vs the app). Open via Help icon → "Open" next to Sandbox vault, or command "Open sandbox vault". Desktop only (mobile users can download a copy of the help vault). Closing its window closes it.
- **Settings → General** links to help and update channels.

---

## 18. Related Core Plugins (inventory)

Complete core-plugin list (each a toggleable built-in; some off by default):

| Plugin | Purpose |
|---|---|
| Audio recorder | Record audio into a note |
| Backlinks | Linked & unlinked mentions (§7) |
| Bases | Property-driven database views (separate spec) |
| Bookmarks | Save links to notes, headings, searches, folders, graphs |
| Canvas | Infinite visual board (separate spec) |
| Command palette | §10 |
| Daily notes | Date-based note creation/opening |
| File explorer | §3 |
| File recovery | §15 |
| Footnotes view | Sidebar list of current note's footnotes |
| Format converter | §16 |
| Graph view | Vault link graph + local graph |
| Note composer | §14 |
| Outgoing links | §7 |
| Outline | Table of contents of active note |
| Page preview | Hover popover previews of links |
| Properties view | §6 |
| Publish | Paid service (out of scope) |
| Quick switcher | §10 |
| Random note | Open a random note |
| Search | §8 |
| Slash commands | Run commands inline with `/` in the editor |
| Slides | Presentations from notes (`---` separators) |
| Sync | Paid service (out of scope) |
| Tags view | All tags with counts |
| Templates | Insert predefined content (`{{title}}`, `{{date}}`, `{{time}}`) |
| Unique note creator | Timestamp-prefixed (Zettelkasten) note creation |
| Web viewer | Open external links inside the app |
| Word count | Status-bar words/characters |
| Workspaces | §9 saved layouts |

---

## Appendix: Source Pages

All under `https://obsidian.md/help/` (redirect target of help.obsidian.md): `manage-vaults`, `data-storage`, `configuration-folder`, `file-formats`, `manage-notes`, `attachments`, `plugins/file-explorer`, `drag-and-drop`, `edit-and-read`, `syntax`, `advanced-syntax`, `obsidian-flavored-markdown`, `links`, `embeds`, `callouts`, `tags`, `aliases`, `properties`, `plugins/properties`, `plugins/backlinks`, `plugins/outgoing-links`, `plugins/search`, `workspace`, `tabs`, `sidebar`, `ribbon`, `status-bar`, `pop-out-windows`, `plugins/workspaces`, `plugins/command-palette`, `plugins/quick-switcher`, `hotkeys`, `editing-shortcuts`, `settings`, `appearance`, `themes`, `snippets`, `plugins/note-composer`, `plugins/file-recovery`, `plugins/format-converter`, `sandbox`, `mobile`, `multiple-cursors`, `folding`, `plugins`, `obsidian`.

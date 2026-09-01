# Obsidian Core Plugins — Behavior Specification

Source of truth for the clean-room clone. All behavior below is reverse-engineered from the **official documentation** at help.obsidian.md (now served from `https://obsidian.md/help/...`), fetched 2026-06-10. The core-plugin index lists **30 core plugins** (verified against `https://obsidian.md/help/plugins` and the sitemap). Importer is **not** a core plugin (see its section).

Canonical core-plugin list and one-line descriptions from the index page:

| Plugin | Official description |
|---|---|
| Audio recorder | "Record and save audio recordings directly in a note." |
| Backlinks | "See all the links and unlinked mentions of a note." |
| Bases | "Create custom views that let you edit, sort, and filter files using their properties." |
| Bookmarks | "Save links to notes, headings, searches, and more." |
| Canvas | "Organize notes visually with an infinite space to lay out ideas." |
| Command palette | "Quickly access commands from your keyboard." |
| Daily notes | "Create and open notes based on the current date." |
| File explorer | "Browse files and folders inside your vault." |
| File recovery | "Recover your work from regular snapshots." |
| Footnotes view | "Show a list of footnotes from the current note." |
| Format converter | "Convert Markdown from other apps to Obsidian format." |
| Graph view | "Visualize relationships between notes in your vault." |
| Note composer | "Merge two notes or split one into two." |
| Outgoing links | "Show all links for the active note." |
| Outline | "Show the table of contents for the active note." |
| Page preview | "Preview the contents of a note by hovering over links." |
| Properties view | "List all the properties in your vault, and see properties for the active note." |
| Publish | Host notes as a website, wiki, or documentation (paid service). |
| Quick switcher | "Search, create and open notes from your keyboard." |
| Random note | "Opens a random note in your vault." |
| Search | "Find files in your vault." |
| Slash commands | "Perform commands inside the editor using the `/` key." |
| Slides | "Create a presentation from your notes." |
| Sync | Synchronize notes across devices (paid service). |
| Tags view | "List all the tags in your vault." |
| Templates | "Insert pre-defined content into your notes." |
| Unique note creator | "Create a unique note using a time-coded title." |
| Web viewer | "Open external links in Obsidian." |
| Word count | "Display the number of words and characters." |
| Workspaces | "Save layouts and switch between them." |

---

## Audio recorder

### Purpose
Lets you record and save audio in a note — for lectures, meetings, or "situations where you can't type fast enough."

### UI surfaces
- **Ribbon icon**: "Start/stop recording" (microphone icon, `lucide-mic`). The icon changes color while recording is active. Single click toggles recording on/off.

### Commands
- **Start/stop recording** — the single toggle command.

### Settings
- None documented.

### Behavior
1. User opens or creates a note.
2. Click ribbon mic icon → recording starts; icon color indicates active state.
3. Click again → recording stops.
4. The audio file is saved into the vault and **automatically embedded at the end of the active note** using standard embed syntax.
5. The audio file persists in the vault even if the embed is removed from the note; user deletes it manually via File explorer.

### File formats
- Writes an audio file to the vault (docs do not name the codec; Obsidian uses `.webm` in practice — verify at implementation time). Embeds via the standard `![[file]]` mechanism.

### Interactions
- File explorer (file management), embed system, attachment-location settings.

### Prerequisites
- A configured microphone.

---

## Backlinks

### Purpose
Discover which notes reference the active note — both explicit internal links and plain-text "unlinked mentions."

### UI surfaces
- **Right-sidebar "Backlinks" tab** (links-coming-in icon) with two collapsible sections:
  - **Linked mentions** — backlinks containing explicit internal links to the active note.
  - **Unlinked mentions** — occurrences of the active note's name (or alias) in other notes without an explicit link; each offers a button to convert the mention into a link.
- **Linked backlinks tab** — a separate, persistent tab pinned to a *specific* note, showing its backlinks regardless of which note is active (displays a link icon to indicate binding).
- **Backlinks in document** — an optional collapsible backlinks section rendered at the bottom of the note itself.

### Settings (in the backlinks pane)
- **Collapse results** — toggle expansion of each note's mention list.
- **Show more context** — toggle paragraph truncation around each mention.
- **Change sort order** — sort order of mentions.
- **Show search filter** — toggles a search field that filters mentions using Search syntax.
- **Backlink in document** (plugin setting) — when enabled, automatically shows backlinks at the bottom of every opened note.

### Commands
1. `Backlinks: Show backlinks` — reveal the Backlinks sidebar tab.
2. `Backlinks: Open backlinks for the current note` — open a note-bound linked backlinks tab.
3. `Backlinks: Toggle backlinks in document` — toggle the in-note backlinks section.

### Interactions
- Uses Search syntax for the filter field.
- Notes matching the vault-wide **Excluded files** patterns do not appear in Unlinked mentions.
- Canvas text-only cards do not appear as backlinks (see Canvas).

---

## Bases

### Purpose
"A core plugin that lets you create database-like views of your notes." A base lets you **view, edit, sort, and filter files and their properties**. All data lives in local Markdown files and their frontmatter properties — the base itself is only a view definition.

### File formats
- **`.base` files** — standalone YAML documents defining a base.
- **Embedded bases** — the same YAML inside a ` ```base ` code block in any Markdown note.
- **Embedding a base file**: `![[File.base]]` (renders the first view) or `![[File.base#ViewName]]` (renders a specific view).

### Creating a base
- Command palette: `Bases: Create new base` (creates a `.base` file in the same folder as the active file) and `Bases: Insert new base` (creates a base embedded as a code block in the current file).
- File explorer: right-click folder → **New base**.
- Ribbon: **Create new base** (same folder as active file).
- Command palette: `Bases: Add view` adds a view to the current base.

### Toolbar UI (top of every base)
- **View menu** — create, edit, switch views. First view in the list loads by default. Drag views by their icon to reorder. Click view name → right arrow (or right-click the view name) for view settings. "Add view" creates a new view.
- **Results** — shows result count; limit, copy, and export files.
  - **Copy** puts the view on the clipboard, pasteable into Markdown or spreadsheets (Google Sheets, Excel, Numbers).
  - **Export** saves a **CSV** of the current view.
- **Sort** — sort and group files (see below).
- **Filter** — filter files (see below).
- **Properties** — choose which properties to display and create formulas.
- **Search** — search items using their displayed properties.
- **New** — create a new file in the current view.

### Filters
- Two scopes: **All views** (base-wide) and **This view** (active view only). Global and view filters concatenate with AND.
- Each filter row = **Property** (from vault properties) + **Operator** (varies by property type) + **Value** (supports math and functions).
- Conjunctions: "All the following are true" (AND), "Any of the following are true" (OR), "None of the following are true" (NOT). Filter groups nest via combinations of conjunctions.
- A **code button** opens the advanced filter editor exposing raw filter syntax for functions not available in the GUI.

### Sort and group
- Sort by one or more properties ASC/DESC; multiple sorts prioritized via drag handles.
- Sort options by type — Text: A→Z / Z→A; Number: smallest→largest / largest→smallest; Date: old→new / new→old.
- **Group by** exactly one property to split results into visually distinct sections.

### `.base` YAML syntax (complete)

Top-level keys: `filters`, `formulas`, `properties`, `summaries`, `views`.

```yaml
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
```

- **filters**: recursive objects keyed `and` / `or` / `not`; leaves are strings that evaluate truthy/falsey using comparison operators (`==`, `!=`, `>`, `<`, `>=`, `<=`) and functions.
- **formulas**: named computed properties; string expressions over properties, operators, and functions.
- **properties**: per-property display config, currently `displayName` (used for table headers etc.).
- **summaries**: named custom aggregations using the `values` keyword (the column's visible values).
- **views**: array; each view has `type` (built-in or plugin-provided), `name` (also used by `![[base#View]]`), optional `filters`, `order` (column/property order), `sort`, `groupBy` (`property` + `direction: ASC|DESC`), `limit`, `summaries` (map of property → summary name), plus layout-specific options.

### Property namespaces
- **Note properties** (frontmatter): `note.author`, shorthand `author`.
- **File properties**: `file.name` (string), `file.basename` (name w/o extension), `file.path`, `file.folder`, `file.ext`, `file.size` (bytes), `file.ctime` (date), `file.mtime` (date), `file.tags` (list, includes inline tags), `file.links` (list of internal links), `file.backlinks` (list; performance-heavy), `file.embeds` (list), `file.properties` (object of all frontmatter), `file.file` (file object for functions).
- **Formula properties**: `formula.<name>`.
- **`this` keyword**: in the main content area → the base file's own properties; in an embedded base → the embedding file's properties; in the sidebar → the active file in the main content area.

### Type system
- Strings: `'…'` or `"…"`. Numbers: `1`, `(2.5)`. Booleans: unquoted `true`/`false`. Dates: `date("2025-01-01 12:00:00")`. Lists: `list()`, indexed `[i]`. Objects: dot notation or `prop["subprop"]`. Links: `link("filename")` / `link("filename", "display")`; links in frontmatter are auto-recognized. Links compare equal if they point to the same file and are comparable to files with `==`/`!=`.
- **Date arithmetic**: `date + "1M"`, `date - "2h"`, `now() + "1 day"`, `file.mtime > now() - "1 week"`. Duration units: `y/year`, `M/month`, `w/week`, `d/day`, `h/hour`, `m/minute`, `s/second`.

### Functions (complete reference)

**Global**: `escapeHTML(html)` → string; `date(string)` → date (format `YYYY-MM-DD HH:mm:ss`); `duration(value)` → duration (e.g. `duration('1d')`); `file(path|file|url)` → file; `html(string)` → renderable HTML; `if(condition, trueResult, falseResult?)`; `image(path|file|url)` → image rendered in the view; `icon(name)` → Lucide icon; `link(path, display?)` → Link; `list(element)` → wraps in list; `max(...numbers)`; `min(...numbers)`; `now()` → current datetime; `number(input)` (dates → ms, booleans → 0/1); `today()` → current date at midnight; `random()` → 0–1, refreshes on view load.

**Any type**: `.isTruthy()`, `.isType(type)`, `.toString()`.

**String**: `.length` (field), `.contains(v)`, `.containsAll(...v)`, `.containsAny(...v)`, `.endsWith(q)`, `.isEmpty()`, `.lower()`, `.replace(pattern|regexp, replacement)` (regex capture groups `$1`…), `.repeat(n)`, `.reverse()`, `.slice(start, end?)`, `.split(sep|regexp, n?)`, `.startsWith(q)`, `.title()` (capitalize each word), `.trim()`.

**Number**: `.abs()`, `.ceil()`, `.floor()`, `.isEmpty()`, `.round(digits?)`, `.toFixed(precision)` → string.

**Date**: fields `.year`, `.month` (1–12), `.day`, `.hour` (0–23), `.minute`, `.second`, `.millisecond`; `.date()` (strip time), `.format(momentPattern)`, `.time()` → string, `.relative()` (human-readable vs now), `.isEmpty()` (always false for dates).

**List**: `.length` (field), `.contains(v)`, `.containsAll(...)`, `.containsAny(...)`, `.filter(expr)` (vars `value`, `index`), `.flat()`, `.isEmpty()`, `.join(sep)`, `.map(expr)` (vars `value`, `index`), `.reduce(expr, acc)` (vars `value`, `index`, `acc`), `.reverse()`, `.slice(start, end?)`, `.sort()`, `.unique()`.

**Link**: `.asFile()` → file (if valid local reference), `.linksTo(file)` → boolean.

**File**: fields as listed under property namespaces, plus `.asLink(display?)`, `.hasLink(otherFile|string)`, `.hasProperty(name)`, `.hasTag(...values)` (includes nested tags), `.inFolder(folder)` (includes subfolders).

**Object**: `.isEmpty()`, `.keys()`, `.values()`.

**Regexp**: `/pattern/.matches(string)` → boolean.

### View layouts

**Table** (v1.9+) — files as rows, columns from properties.
- **Row height**: short / medium / tall / extra tall.
- **Summaries**: right-click column header → "Summarize…" → built-in or custom formula. Results render at column bottoms; when grouped, at group tops. Per-view (the same column can have different summaries in different views). Built-ins — all types: Empty, Filled, Unique; numbers: Average, Max, Median, Min, Range, Stddev, Sum; dates: Earliest, Latest, Range; checkbox: Checked, Unchecked. Custom summaries are named formulas over `values` (e.g. `values.reduce(...)`).
- **Keyboard**: Ctrl/Cmd+C copy, Ctrl/Cmd+V paste, Tab/Shift+Tab cell navigation, Ctrl+Space select column, Shift+Space select row, Enter focus/toggle, Home/End first/last column, Backspace clear cells, Esc clear selection.

**Cards** (v1.9+) — gallery-like grid with optional cover images.
- **Card size** — card width.
- **Image property** — property supplying the cover; accepts local attachment links (`"[[path/img.jpg]]"`), external URLs, or hex color codes (`#000000`).
- **Image fit** — `Cover` (fills content box, may crop) or `Contain` (scaled to fit, never cropped).
- **Image aspect ratio** — controls cover height; default 1:1.

**List** (v1.10+) — bulleted/numbered list.
- **Markers**: bullets / numbers / none.
- **Indent properties**: when on, non-primary properties render as indented sub-items; primary property = topmost in the Properties menu (drag, or Alt+Up/Down).
- **Separator**: when indent/nesting is off, the character separating properties on one line (default comma).

**Map** (v1.10+) — files as pins on an interactive map. **Requires the Maps plugin** (official plugin installed separately); Obsidian 1.10+.
- File frontmatter: `coordinates` as `"lat, lng"` text or `["lat", "lng"]` list; optional `icon` (Lucide name, e.g. `landmark`, `utensils`); optional `color` (hex/RGB/named CSS).
- View settings: marker coordinates property (required), marker icon property, marker color property/formula; center coordinates, zoom constraints, embedded height, background/tiles.
- Map tiles customizable via TileJSON or tile URLs (e.g. OpenFreeMap free styles: Dark, Positron, Liberty).
- Formula-based icons/colors supported (e.g. `list(type)[0].asFile().properties.icon`).

Community plugins can register additional view layouts.

### Interactions
- Reads/writes note frontmatter (editing a cell edits the file's properties). Integrates with Properties, tags, links, Search-like filtering, attachments (cover images), Maps plugin.

---

## Bookmarks

### Purpose
"A bookmark is a 'shortcut' that immediately takes you to the bookmarked item."

### Bookmarkable item types
Files, Folders, Graphs (global graph configurations), Searches (queries), Headings, Blocks, Links (web URLs via Web viewer). Constraint: **local graphs cannot be bookmarked**.

### UI surfaces
- **Bookmarks tab** in the left sidebar (`lucide-bookmark` icon); shown via command `Bookmarks: Show bookmarks`.
- Tab header buttons: **Bookmark the active tab** (`lucide-bookmark-plus`), **New bookmark group** (`lucide-folder-plus`), plus sort/collapse controls.
- Entry points for creating bookmarks:
  - File explorer: right-click file/folder → **Bookmark**; multi-select (Alt+click individual, Shift+click range) → right-click → **Bookmark all**.
  - Command palette: "Bookmark…" commands, including **Bookmark heading under cursor** and **Bookmark block under cursor**.
  - Search pane: three-dot menu next to the result count → bookmark the search.
  - Graph tab: right-click → Bookmark.
  - Heading: right-click → **Bookmark this heading**.
  - Web viewer: address-bar three-dot menu → Bookmark (or command palette while a web page is focused).
  - Tab group: tab-group dropdown → **Bookmark [N] tabs**.

### Bookmark creation/editing
- On creation: optional **custom title** and **group** assignment.
- **Edit bookmark** dialog to modify existing bookmarks.
- Right-click bookmark → **Remove**. Removing a group removes all bookmarks inside it.

### Organization
- Groups (folders of bookmarks), expandable/collapsible, nestable.
- Drag bookmarks to reorder and to move between groups.
- Selecting a bookmark opens the item.

### Commands
- `Bookmarks: Show bookmarks`
- Bookmark the active tab / current file
- `Bookmark heading under cursor`
- `Bookmark block under cursor`

### Storage
- Bookmarks are vault configuration (stored under the vault's `.obsidian` config folder — `bookmarks.json` in practice; docs don't name the file).

### Interactions
- Web viewer (URL bookmarks), Search (saved searches), Graph view (saved graph configs), File explorer, Command palette.

---

## Canvas

### Purpose
"Canvas is a core plugin for visual note-taking. It gives you infinite space to lay out notes and connect them to other notes, attachments, and web pages."

### Creating a canvas
- Command palette: `Canvas: Create new canvas` (creates in the active file's folder).
- File explorer: right-click folder → **New canvas**.
- Ribbon: **Create new canvas** icon.

### Card types
1. **Text cards** (no file reference) — double-click empty canvas, or the blank-file icon in the bottom toolbar. Support Markdown, links, code blocks. **Not visible in Backlinks** unless converted: right-click → **Convert to file…**.
2. **Note cards** — document icon in bottom toolbar, right-click → **Add note from vault**, or drag from File explorer. Double-click to edit inline. Right-click → **Swap file** to point at a different note.
3. **Media cards** — image icon in bottom toolbar, right-click → **Add media from vault**, or drag in. Supports images, audio, PDFs, and unrecognized file types.
4. **Web page cards** — right-click → **Add web page** (enter URL), or drag a URL from a browser. Open externally: Ctrl/Cmd+click the card label or right-click → **Open in browser**. (With Web viewer enabled, web cards can open as Web viewer tabs.)
5. **Folder cards** — drag a folder from File explorer to add all contained files.

### Card operations
- **Select**: click; box-select by dragging; Shift+click to add/remove; Ctrl/Cmd+A select all.
- **Move**: drag (selection brings card to front). **Duplicate**: Alt/Option+drag. **Constrain axis**: Shift+drag. **Disable snapping**: hold Space while dragging.
- **Resize**: drag edges; Shift preserves aspect ratio; Space disables snapping.
- **Edit**: double-click a text/note card; Esc to stop editing.
- **Delete**: right-click → Delete, Backspace/Delete key, or the remove icon in the floating selection controls.
- **Color**: select cards/connections → selection controls → **Set color** → preset color or custom.

### Connections (edges)
- **Create**: hover a card edge until a filled circle appears, drag to the target card's edge. Dragging into empty space creates a new card at the endpoint.
- **Disconnect**: hover the line until endpoint circles appear, drag a circle off the card; or right-click line → **Remove**; or select line + Backspace/Delete.
- **Reconnect**: drag an endpoint circle to another card.
- **Navigate**: right-click line → **Go to target** / **Go to source**.
- **Label**: double-click the line, type, Esc; or select line → **Edit label**; edit via double-click or right-click → Edit label.

### Groups
- Empty group: right-click canvas → **Create group**. From selection: select cards → right-click → **Create group**.
- Rename: double-click the group name, Enter to save.
- Moving a group moves its contents.

### Navigation
- **Pan**: Space+drag, middle-mouse drag, scroll (vertical) / Shift+scroll (horizontal).
- **Zoom**: Ctrl/Cmd (or Space)+scroll; zoom in/out buttons (upper right); **Zoom to fit** button or Shift+1; **Zoom to selection** via right-click → Zoom to selection or Shift+2; reset via zoom controls.

### File format — `.canvas` (open **JSON Canvas 1.0** spec, jsoncanvas.org)
Top level: optional arrays `nodes` and `edges`. Nodes appear in the array in **ascending z-index order**.

All nodes: `id` (unique string), `type` (`text` | `file` | `link` | `group`), `x`, `y` (integer px), `width`, `height` (integer px), optional `color` (canvasColor).
- `text` nodes: required `text` (Markdown string).
- `file` nodes: required `file` (vault path); optional `subpath` (heading/block reference, starts with `#`).
- `link` nodes: required `url`.
- `group` nodes: optional `label`, optional `background` (image path), optional `backgroundStyle` (`cover` | `ratio` | `repeat`).

Edges: required `id`, `fromNode`, `toNode`; optional `fromSide`/`toSide` (`top` | `right` | `bottom` | `left`); optional `fromEnd`/`toEnd` (`none` | `arrow`; defaults `none`/`arrow` respectively); optional `color` (canvasColor); optional `label`.

canvasColor: hex string (`"#FF0000"`) or preset numbers `"1"`–`"6"` = red, orange, yellow, green, cyan, purple (exact preset values intentionally undefined — theme-controlled).

### Interactions
- Canvases can be **embedded** in notes with standard embed syntax (`![[My.canvas]]`).
- Backlinks: note cards participate normally; text cards do not until converted to files.
- File recovery snapshots `.canvas` files. Search searches canvas content.

---

## Command palette

### Purpose
Run any command from the keyboard and explore all available commands and their shortcuts.

### UI / access
- **Hotkey**: Ctrl+P (Win/Linux) / Cmd+P (macOS).
- Ribbon: Command palette icon.
- Modal: type to filter, arrow keys to select, Enter to execute. Each row shows the command's assigned hotkey, if any.

### Search behavior
- **Fuzzy matching** — e.g. "scf" matches "**S**ave **c**urrent **f**ile".
- Since v1.8.3: recently used commands surface at the top but remain subject to fuzzy filtering; shorter command names take priority over recency when filtering.

### Settings (Settings → Command palette)
- **Pinned commands**: "New pinned command" → "Select a command" → pick + Enter. Pinned commands appear at the top of the palette before typing. Unpin via the cross icon next to a pinned command.

### Interactions
- Hotkeys settings let any command bypass the palette entirely.

---

## Daily notes

### Purpose
"Opens a note based on today's date, or creates it if it doesn't exist." For journals, to-do lists, daily logs.

### UI surfaces
- **Ribbon icon**: "Open today's daily note" (calendar icon).

### Commands
- **Open today's daily note** (hotkey-assignable).

### Settings
1. **Date format** — note name format, default `YYYY-MM-DD` (Moment.js tokens). Format strings containing `/` create **nested folders**, e.g. `YYYY/MMMM/YYYY-MMM-DD` → `2024/January/2024-Jan-15`.
2. **New file location** — folder where daily notes are created.
3. **Template file location** — a template note applied to each new daily note (e.g. one containing `# {{date:YYYY-MM-DD}}`).

(Only these three settings are documented on the help page.)

### Behavior
- Invoking opens today's note if it exists; otherwise creates it (from the template if configured) and opens it.
- **Date-property linking**: a date property whose value matches the daily-note format renders as a clickable link to the corresponding daily note in Live Preview.

### Interactions
- Templates plugin variables (`{{date}}`, `{{time}}`, `{{title}}`, with `:FORMAT`) work in daily-note templates.

---

## File explorer (Files)

### Purpose
"Manage files and folders inside your vault" — browse and perform operations on notes and other accepted file formats.

### UI surfaces
Left-sidebar tree view. Header buttons:
- **New note** (pen icon) — creates at the default new-note location (Settings → Files and links → Default location for new notes).
- **New folder** (folder-plus icon) — creates at vault root; subfolders via right-click on a parent folder.
- **Change sort order** — ascending/descending by file name, modified time, or created time.
- **Auto-reveal active file** — scrolls to and highlights the currently open note.
- **Expand all** / **Collapse all** folders.

### Operations
- **Create note in folder**: right-click folder → New note. Also New canvas / New base via context menu (registered by those plugins).
- **Rename**: right-click → Rename, type, Enter.
- **Delete**: right-click → Delete (confirmation prompt may appear; deletion target — system trash / `.trash` / permanent — is a vault-wide "Files and links" setting).
- **Move by drag**: drag file/folder onto destination folder.
- **Move by menu**: right-click → **Move file to…** → search destination folder.
- **Multi-select**: Alt/Opt+click individual files; Shift+click contiguous range; operations apply to the selection (e.g. Bookmark all, move).
- **Drag into a note** creates a link to the dragged file.

### Context menu (additional integrations)
Bookmark, Merge entire file with… (Note composer), Open version history (Sync), etc. — other plugins contribute items.

### Interactions
- Page preview on hover; honors vault "Excluded files"; default new-note location setting; attachments visibility governed by "Detect all file extensions" (Files and links settings).

---

## File recovery

### Purpose
"Protects your work from accidental deletions, file corruption, or unwanted changes by automatically saving complete snapshots." Explicitly **not** a full backup solution.

### Scope
- Only **`.md`** and **`.canvas`** files are snapshotted/restorable.

### Settings (Settings → Core plugins → File recovery)
- **Snapshot interval** — minimum interval between snapshots; minimum 5 minutes (configurable).
- **History length / retention** — default 7 days (configurable).
- **Snapshots → View** — opens the recovery browser.
- **Clear history** — irreversibly deletes all snapshots.

### Snapshot architecture
- Snapshots store the **full content** of files, not diffs.
- Stored in the **global settings directory outside the vault**, keyed by **absolute paths** to notes.
- **Device-local**: snapshots never sync (not via Obsidian Sync nor other services).
- Moving a vault without the vault switcher breaks snapshot association.

### Recovery workflow
1. Settings → File recovery → Snapshots → **View**.
2. Search for a filename, select from suggestions.
3. Browse available snapshots for that file.
4. **Copy** (duplicate snapshot content into a new note) or **Restore** (replace the file's content entirely).
5. Optional **Show changes** toggle: diff view of additions/removals/modifications between versions.

### Limitations
- Apple Lockdown Mode disables the feature unless Obsidian is exempted.
- Large, frequently edited files can accumulate significant snapshot storage.

---

## Footnotes view

### Purpose
Lists all footnotes from the current (active) note in a panel.

### UI surfaces
- **Footnotes panel** (sidebar view) listing each footnote in the active note; updates as the active note changes.

### Behavior
- "Click a footnote to edit its text."
- Navigate to a footnote's position in the note from the panel.

### Settings / Commands
- None documented (a "Show footnotes" view command exists implicitly to open the panel, as with all sidebar views).

### Interactions
- Operates on Markdown footnote syntax (`[^1]` … `[^1]: text`).

---

## Format converter

### Purpose
"Lets you convert Markdown from other applications to Obsidian format. It also lets you convert certain Properties to new required formats."

### Warning behavior
"Format converter converts your **entire vault** based on your settings." Users must back up first.

### UI / access
- Command palette: **Open format converter**.
- Ribbon icon (`lucide-binary`).
- Modal with **checkboxes per conversion** and a **Start conversion** button.

### Conversions
**Roam Research**
- Tags: `#tag` and `#[[tag]]` → `[[tag]]`
- Highlights: `^^highlight^^` → `==highlight==`
- TODOs: `{{[[TODO]]}}` → `[ ]`

**Bear**
- Highlights: `::highlight::` → `==highlight==`

**Zettelkasten links**
- Full links: `[[UID]]` → `[[UID File Name]]`
- Pretty links: `[[UID]]` → `[[UID File Name|File Name]]`

**Properties migration (Obsidian 1.9.3+)**
- `alias:` (single value) → `aliases:` (list)
- `tag:` (comma-separated) → `tags:` (list)
- `cssclass:` → `cssclasses:` (list)

### Behavior
- Applies all enabled conversions vault-wide in one pass.

---

## Graph view

### Purpose
"Visualize the relationships between the notes in your vault." Nodes = notes (and optionally tags/attachments); lines = internal links. **Node size correlates with the number of inbound references.**

### Graph types
- **Global graph** — all notes; opened via "Open graph view" (ribbon/command).
- **Local graph** — notes connected to the active note; "Open local graph" command; **depth slider** controls how many hops away to include.

### Interactions (canvas)
- Hover a node → highlights its connections.
- Click a node → opens the note.
- Right-click → context menu of actions.
- Zoom: scroll wheel or `+`/`-` keys. Pan: drag, or arrow keys (Shift accelerates).

### Filters panel
- **Search files** — filter nodes by a search term (full Search syntax).
- **Tags** — toggle tag nodes.
- **Attachments** — toggle attachment nodes.
- **Existing files only** — hide links to non-existent (unresolved) notes.
- **Orphans** — toggle notes with no links.
- Vault **Excluded files** are automatically hidden.

### Groups panel
- **New group** → enter a search term + pick a color (color circle). Matching nodes are tinted with the group color.

### Display panel
- **Arrows** — show link direction.
- **Text fade threshold** — zoom level at which node labels fade.
- **Node size** — node circle scale.
- **Link thickness** — line width.
- **Animate** — triggers the time-lapse animation: "notes and attachments appear in chronological order based on their creation time."

### Forces panel
- **Center force** — "controls how compact the graph is."
- **Repel force** — node-to-node repulsion strength.
- **Link force** — "controls the pull on each link."
- **Link distance** — "controls the length of the lines between each note."

### Commands
- `Graph view: Open graph view`
- `Graph view: Open local graph`
- (Animate is a panel control, not a command.)

### Interactions
- Global graph configurations can be **bookmarked** (local graphs cannot). Settings persist in vault config (`graph.json` in practice).

---

## Note composer

### Purpose
Combine notes (merge) or split content into separate notes (extract), while keeping all links pointing to the right place.

### Commands & entry points
**Merge**
- File explorer: right-click file → **Merge entire file with…**
- Command palette: `Note composer: Merge current file with another file…`
- "Merging notes adds a note to another and removes the first one." "Note composer updates all links to reference the merged note."
- In the target-picker modal: **Enter** appends source to destination end; **Shift+Enter** prepends to destination start; **Ctrl/Cmd+Enter** creates a new note with the content.

**Extract selection**
- Editor: right-click selected text → **Extract current selection…**
- Command palette: `Note composer: Extract current selection…`
- Same Enter / Shift+Enter / Ctrl/Cmd+Enter semantics for the destination.
- "By default, Note composer replaces the extracted text with a link to the destination note."

(A heading-scoped variant — extract the section under a heading — is exposed through the heading context menu in the app; the help page documents selection extraction.)

### Settings
- **Ask before merging** (confirmation toggle; default enabled). If disabled, a bad merge "can still be recovered with the File recovery plugin."
- **Text after extraction** — what replaces the extracted text: a **link** to the destination note (default), an **embed** of the destination note, or **nothing**.
- **Template file location** — template applied to newly created destination notes, with variables:
  - `{{content}}` — the merged/extracted text (appended at bottom if omitted from the template)
  - `{{fromTitle}}` — source note name
  - `{{newTitle}}` — destination note name
  - `{{date:FORMAT}}` — creation date, e.g. `{{date:YYYY-MM-DD}}`

### Interactions
- Link updating across the vault; File recovery as the undo safety net; Templates-style variable substitution.

---

## Outgoing links

### Purpose
Shows all outgoing connections from the active note and surfaces potential links — the inverse of Backlinks.

### UI surfaces
- **Right-sidebar tab** (links-going-out icon) with two sections:
  - **Links** — "lists all links in the active note. Click a link to open the linked note."
  - **Unlinked mentions** — "lists any text in the active note that matches the name or alias of another note in your vault." Click the button showing the note name to convert the mention into a real link. Hover the button to see the full file path (disambiguates same-named notes in different folders).

### Behavior details
- Files matching **Excluded files** patterns don't appear in Unlinked mentions.
- Links inside code blocks: a link created there works, but does not appear under the Links section (code-block content isn't parsed as links).

### Commands
- Show outgoing links (opens the tab).

### Interactions
- Aliases (frontmatter `aliases`) count for unlinked-mention matching; complements Backlinks.

---

## Outline

### Purpose
"Outline is a core plugin that lists the headings in the active note" — a table of contents.

### UI surfaces
- Sidebar **Outline** tab showing the heading hierarchy of the active note.

### Behavior
- **Click** a heading to jump to that section.
- **Drag** headings within the outline to **rearrange the corresponding sections** in the note.
- (The official page documents only navigation and drag-reorganization; collapse arrows and a filter field exist in the app but are not specified in the help doc.)

### Commands
- Show outline (opens the tab).

---

## Page preview

### Purpose
"Preview a page when you hover the cursor over an internal link, without needing to navigate to it" — popover preview of the link target.

### Default behavior
- Enabled by default and active across multiple surfaces: links in **File explorer, Search, Backlinks**, "and similar areas" trigger on plain hover.
- In **Editing view**, hovering requires holding **Ctrl/Cmd**.

### Settings (Settings → Core plugins → Page preview)
- Per-surface toggles to require **Ctrl/Cmd while hovering** — when a surface's toggle is enabled, the modifier is required everywhere for that surface, not just in Editing view. Turning a surface's option off disables hover preview for it entirely.

### Interactions
- Works on internal links, and other plugins' panes opt in (Backlinks, Search, Outline, Bookmarks, etc.).

### Geode implementation subset
- Reading View previews resolved Markdown links and wikilinks on plain hover. Live Preview requires Cmd/Ctrl and only previews rendered link decorations (never raw source on the active line).
- The first-class preview card shows the resolved note path/title and a safe, non-editable rendered excerpt; authored heading targets are scoped to that section.
- Follow-up: add the Core plugins → Page preview per-surface modifier settings and opt-in surfaces (File explorer, Search, Backlinks, Outline, Bookmarks, and plugin hover-link sources). Geode's current Settings model has no core-plugin category, so that broader settings architecture is intentionally not hidden inside this initial Markdown-view delivery.

---

## Properties view

### Purpose
Sidebar views for managing note frontmatter properties across the vault.

### UI surfaces
- **File properties view** — "shows a view of the properties for the active note" (sidebar version of the in-note Properties editor); updates with the active note.
- **All properties view** — "shows a list of all the properties in your vault and their type."

### Behavior
- **Sorting**: by property name or by frequency (usage count across the vault).
- **Click a property** → opens Search with the property search syntax pre-populated.
- **Right-click a property** → global **rename** of that property across the vault.

### Commands
- `Show file properties` / `Show all properties` (open the respective views).

### Interactions
- Bridges to Search (`[property]` syntax); edits write YAML frontmatter; property types come from the vault-wide property type registry.

---

## Publish (paid service overview)

### Purpose
"A cloud-based hosting service that lets you publish your notes as a wiki, knowledge base, documentation, or digital garden." Sites live at `publish.obsidian.md/your-site` (or a custom domain). help.obsidian.md itself is a Publish site.

### Capabilities
- Multiple sites per account; site management.
- **Collaboration** — share sites with others.
- **Custom domains** and **permalinks** ("define permanent URLs for pages").
- **Analytics** setup, **SEO** options, security & privacy controls (password protection is offered as a paid add-on per the product, though the fetched overview page did not detail it).

### Publish workflow (in-app UI)
- Ribbon → **Publish changes** → dialog → select notes → **Publish**.
- Modal tabs:
  - **NEW** — all unpublished notes.
  - **CHANGED** — all notes modified since last publish.
  - **UNCHANGED** — all published notes (used for unpublishing: select and publish the deletion).
- Renamed/removed items are **not deleted automatically**; the user must manually check the deletion checkbox (safety).
- Unpublished notes remain in the local vault.
- **Publish flag**: frontmatter `publish: true` auto-selects a note for publishing and **overrides excluded folders**; `publish: false` excludes it.
- **Manage publish filters** icon: designate included/excluded folders.
- **Add linked**: auto-selects media referenced by the chosen notes (respecting exclusions).

### Site customization
- Root-published static assets: `publish.css` (custom styles), `publish.js` (custom JS — requires custom domain), favicons (`favicon.ico`, `favicon-32x32.png`, … up to 196px). Obsidian itself can't edit CSS/JS files; they're created externally and published.
- Community theme: copy the theme CSS from `.obsidian/themes/...`, rename to `publish.css`, publish. (Style Settings customizations do not apply on Publish; light/dark mode toggle is available in site options.)
- **Site options** — "Reading experience" and "Components" sections toggle: graph view, table of contents (outline), file-explorer navigation, etc.
- **Navigation customization** — reorder files/folders, hide published items from navigation (right-click menu, with restore).

---

## Quick switcher

### Purpose
Keyboard-driven search/open/create of notes by name or alias.

### UI / access
- **Hotkey**: Ctrl+O / Cmd+O.
- Ribbon: "Open Quick switcher".
- Mobile: plus icon at bottom center (when not editing).

### Behavior
- Type to filter notes by **name or alias**; arrow keys navigate; **Enter** opens.
- **Empty query** shows the most recently accessed notes — so "switcher → Down → Enter" toggles between the two most recent notes.
- **Create**: Enter on a non-matching query creates a new note with that name; **Shift+Enter** forces creation with the exact typed name even when similar notes exist.
- **Ctrl/Cmd+Enter** opens the selected note in a new tab.
- Files matching **Excluded files** patterns are **deprioritized** (ranked lower), not hidden.
- Vaults over **10,000 items** switch to a simpler result-ranking algorithm for performance.

### Settings
- The help page does not enumerate settings. (The app exposes toggles such as "Show all file types", "Show attachments", and "Show existing files only" — verify in-app at implementation time.)

---

## Random note

### Purpose
"Opens a random note within your vault. Rediscover notes to add new insights, or link to recently added notes."

### UI surfaces
- Ribbon button **Open random note** (dice icon).

### Commands
- `Random note: Open random note`.

### Settings
- None documented.

---

## Search

### Purpose
"Search is a core plugin that helps you find data in your Obsidian vault by using search terms and operators to narrow down results."

### UI / access
- **Search tab** in the left sidebar.
- **Hotkey**: Ctrl+Shift+F / Cmd+Shift+F. If text is selected when invoked, it is searched automatically.
- Empty search box shows **recent search history**.
- **Match case** toggle icon in the search bar (default: case-insensitive).
- Sort dropdown under the search field (default **File name A→Z**): File name A→Z / Z→A, Modified time new→old / old→new, Created time new→old / old→new.
- Three-dot menu next to the result count → **Copy search results** (with options for link style/context).

### Search scope
By default "Obsidian only searches the contents of notes and canvases." Use `path:`/`file:` to match all vault files by name/path.

### Syntax
- Plain terms: implicit AND, matched independently anywhere in a file: `meeting work`.
- Exact phrase: `"star wars"`; escaped quotes: `"they said \"hello\" to each other"`.
- **OR**: `meeting OR work`; combine: `meeting work OR meetup personal`.
- **Grouping**: `meeting (work OR meetup) personal`.
- **Negation**: `-work`; group negation: `meeting -(work meetup)`.
- **Regex**: `/\d{4}-\d{2}-\d{2}/` (JavaScript-flavored), combinable with operators: `path:/\d{4}-\d{2}-\d{2}/`.

### Operators
| Operator | Function | Example |
|---|---|---|
| `file:` | match file name (any file type) | `file:.jpg`, `file:202209` |
| `path:` | match file path | `path:"Daily notes/2022-07"` |
| `content:` | match file content | `content:"happy cat"` |
| `match-case:` | force case-sensitive sub-query | `match-case:HappyCat` |
| `ignore-case:` | force case-insensitive sub-query | `ignore-case:ikea` |
| `tag:` | find tag (ignores code blocks) | `tag:#work` |
| `line:()` | terms must share one line; negatable `-line:` | `line:(mix flour)` |
| `block:()` | terms must share one block (slower) | `block:(dog cat)` |
| `section:()` | terms must share one heading section | `section:(dog cat)` |
| `task:` | match task content | `task:call` |
| `task-todo:` | uncompleted tasks only | `task-todo:call` |
| `task-done:` | completed tasks only | `task-done:call` |

### Property search
- `[property]` — files having the property.
- `[property:value]` — property with that value.
- `[property:null]` — property with no value.
- Comparison: `[duration:<5]`, `[property:>value]`, etc. (`<`, `>` inside brackets/quotes).
- Property values support sub-queries: OR, grouping, exact match, regex.

### Settings (gear icon in search bar)
- **Explain search term** — plain-language breakdown of the query.
- **Collapse results** — hide/show match context per file.
- **Show more context** — expand surrounding text per match.

### Embedded search
- ` ```query ` code block in a note renders live search results, e.g.:
  ````
  ```query
  embed OR search
  ```
  ````
- Obsidian Publish does **not** render embedded query results.

### Exclusions
- Files matching the vault **Excluded files** patterns don't appear in results.

### Interactions
- Search queries are bookmarkable; Tags view, Properties view, and Graph filters reuse Search syntax.

---

## Slash commands

### Purpose
Execute commands in the editor by typing `/`.

### Trigger
- "Type a forward slash (`/`) at the beginning of a line or after any blank space."

### Behavior
1. `/` opens an inline command menu at the cursor.
2. Typing filters commands with **fuzzy matching** identical to the Command palette ("scf" → "Save current file").
3. Arrow keys navigate, Enter executes.
4. **Esc or Space cancels** the menu without running anything.

### Settings
- None documented.

### Interactions
- Surfaces the same command registry as the Command palette.

---

## Slides

### Purpose
"Slides is a core plugin that lets you create presentations from your notes."

### Slide syntax
- Slide separator: `---` at the start of a line with blank lines before and after.
- Any valid Markdown works inside slides (e.g. *emphasis*, **bold**).

### Starting a presentation
- Right-click a note's tab → **Start presentation**.
- Command palette → `Slides: Start presentation` (presents the active note).

### Presentation UI
- Bottom-right: left/right navigation arrows.
- Upper-right: close (cross) button.

### Navigation keys
- Left/Right arrows: previous/next slide.
- Spacebar: next slide.
- Esc: end presentation.

### Settings
- None documented.

---

## Sync (paid service overview)

### Purpose
"Obsidian Sync is an add-on service that allows you to privately sync your notes across devices" with **end-to-end encryption**.

### Capabilities
- Cross-device sync of vault contents via encrypted remote vaults; subscription plans gate vault sizes and limits.
- **Selective sync** — choose which file categories and settings sync.
- **Version history** — view/restore previous versions.
- **Collaboration** — add team members to a shared vault.
- **Sync regions** — choose/relocate the server region.
- **Headless Sync** — command-line syncing without the desktop app.
- **Status icon and messages** — sync activity log + status indicator; service status at status.obsidian.md.

### Selective sync settings (Settings → Sync)
- File-type toggles, **off by default**: Images, Audio, Videos, PDFs; plus **Sync all other types**.
- **File size limits**: Standard plan up to **5 MB** per file; Plus plan up to **200 MB**.
- **Excluded folders** — user-managed list.
- Always excluded automatically: File recovery snapshots; hidden files/folders starting with `.` — except the `.obsidian` config folder, which syncs.

### Vault configuration sync (defaults on)
"Other file types, Main settings, Appearance, Themes and snippets, Hotkeys, Active core plugin list, Core plugin settings." Community plugins require manually enabling "Active community plugin list" and "Installed community plugin list." Settings history can be viewed/restored from the Vault configuration sync section (reload/restart to apply).

### Device-specific (never synced)
Device name, conflict-resolution preference, pause/resume state, and the sync settings themselves. Hot-reloadable on receipt: hotkeys, appearance, enabled plugin configs; restart needed for CSS changes, graph configs, core plugin enable/disable.

### Version history
- Retention: Standard plan **1 month**; Plus plan **12 months**; attachment versions kept **two weeks**.
- Restore existing file: File explorer → select note → **Open version history** (long-press on mobile) → pick version in left panel (preview right) → **Restore** (replaces contents).
- Restore deleted files: Settings → Sync → **Deleted files → View** → pick note → pick version → Restore (returned to original location). **Bulk restore** via checkboxes / Shift+click.

### Limitations
- Incompatible with Apple Lockdown Mode unless Obsidian is exempted.
- Not recommended simultaneously with third-party cloud folders (Dropbox/Drive/OneDrive) — conflict risk.

---

## Tags view

### Purpose
"Lists all tags in your vault and the number of notes for each tag."

### UI surfaces
- Sidebar **Tags** tab: each tag with its note count; **nested tags** (`#parent/child`) render hierarchically with expand/collapse arrows.

### Settings / controls (in the pane)
- **Sort order**: by tag name or by frequency.
- **Nested tags display**: tree hierarchy vs flat list.
- **Expand all / Collapse all** controls; per-level arrows.

### Behavior
- **Click a tag** → runs a tag search in the Search pane.
- **Ctrl/Cmd+click a tag** → toggles the tag in the current search term (add/remove).
- Counts update live with vault content.

### Commands
- Show tags (opens the pane).

### Interactions
- Built on Search (`tag:` operator); counts include inline `#tags` and frontmatter `tags`.

---

## Templates

### Purpose
"Templates is a core plugin that lets you insert pre-defined snippets of text into your active note."

### Settings (Settings → Core plugins → Templates)
1. **Template folder location** — folder containing template notes.
2. **Date format** — format used by `{{date}}` (default `YYYY-MM-DD`).
3. **Time format** — format used by `{{time}}` (default `HH:mm`).

### Commands
- `Templates: Insert template` — pick a template from the templates folder; its content is inserted at the cursor (or last cursor position if focus is outside the note body).
- `Templates: Insert current date` — inserts the date using the configured format.
- `Templates: Insert current time` — inserts the time using the configured format.

### Template variables
| Variable | Behavior |
|---|---|
| `{{title}}` | Title (file name) of the active note |
| `{{date}}` | Today's date; default `YYYY-MM-DD` |
| `{{time}}` | Current time; default `HH:mm` |
| `{{date:FORMAT}}` / `{{time:FORMAT}}` | Override with Moment.js tokens, e.g. `{{date:YYYY-MM-DD}}` |

### Behavior notes
- Variables are substituted at insertion time.
- Edit templates in **Source mode**: the Properties UI can quote/rewrite unquoted `{{variables}}` in frontmatter.
- The same variables work in **Daily notes** and **Unique note creator** templates.

---

## Unique note creator

### Purpose
"Lets you create notes with time-based names, also known as Zettelkasten notes."

### Default naming
- Timestamp prefix format `YYYYMMDDHHmm` (e.g. `202401010945` = 09:45, Jan 1 2024).
- **Collision handling**: "If a note with the same name exists, the new note uses the next available timestamp."

### UI / commands
- Ribbon: **Create new unique note** (sheets-in-box icon).
- Command palette: `Create new unique note`.

### Settings (Settings → Core plugins → Unique note creator)
- **Template file location** — template applied to each new unique note (default: empty note). (The app also exposes new-file-location and prefix-format settings; the help page documents the template setting.)

### Interactions
- Templates variables apply within the unique-note template.

---

## Web viewer

### Purpose
"Lets you open external links within Obsidian on desktop" — browse and research without leaving the app. **Desktop only.**

### UI surfaces
- Web pages open as regular **tabs** that can be rearranged, split, and moved to pop-out windows; address bar with a three-dot "more actions" menu.
- **Reader view**: "Click the glasses icon to view a plain text version of the web page" — powered by Mozilla's Readability library (the Firefox reader engine).

### Features & behavior
- **Open external links** in Web viewer tabs (instead of the system browser).
- **Save to vault**: more-actions icon → save the web page into the vault (as Markdown); save location configurable.
- **Ad blocking**: on by default; blocking rules customizable using lists such as EasyList.
- **Bookmarking**: address-bar menu → Bookmark (integrates with Bookmarks plugin).
- Canvas web-page cards can open as Web viewer tabs.

### Settings (Settings → Web viewer)
- Save-page location; ad-blocking rules. (The help page does not enumerate further settings; the app additionally exposes toggles for opening external links, default search engine, and history — verify in-app.)

### Technical / security notes
- Built on a Chromium embedded-webview feature (same one used by Canvas web cards); independently audited.
- Recommended for research only: third-party plugins are not sandboxed and have cookie access while Obsidian runs.

---

## Word count

### Purpose
"Displays the number of words and characters of the active note."

### UI surfaces
- **Desktop**: status bar (bottom right).
- **Mobile**: top of the right sidebar.

### Behavior
- Counts words and characters of the active note; supports **CJK languages** (Chinese/Japanese/Korean), which don't use spaces as word separators (requires CJK-aware word segmentation). (Counting only the current selection when text is selected is in-app behavior not covered by the help page.)

### Settings / Commands
- None documented.

---

## Workspaces

### Purpose
"Manage and switch between different application layouts depending on your task, for example journaling, reading, or writing."

### What a workspace saves
- "Information about open files and tabs."
- "The width and visibility of each sidebar."

### UI / commands
- Ribbon: **Manage workspace layouts** icon.
- Command palette: `Workspaces: Manage workspace layouts` → modal with:
  - List of saved workspaces, each with a **Load** button and a **Delete layout** (X) button.
  - Text input to name and **Save** the current layout as a new workspace.
- Core operations: **Save** (saving under an existing name updates that workspace), **Load**, **Delete**.
- (The app also registers per-workspace "Load <name>" style commands and save/load commands; the help page documents the manager modal.)

### Storage
- Vault configuration (stored under `.obsidian` — `workspaces.json` in practice; file name not confirmed by docs).

---

## Importer (NOT a core plugin)

The user-supplied list included Importer; per official docs it is "an official **Community plugin** made by the Obsidian team," not a core plugin. It "helps you migrate to Obsidian from various apps and formats," is open source at `github.com/obsidianmd/obsidian-importer`, and is installed via the community plugin browser (`obsidian://show-plugin?id=obsidian-importer`). Exclude it from the core-plugin clone surface; treat it as an optional companion tool.

---

## Cross-cutting notes for the clone

1. **Excluded files** (Settings → Files and links) affect Backlinks/Outgoing-links unlinked mentions (hidden), Search results (hidden), Graph (hidden), and Quick switcher (deprioritized, not hidden).
2. **Moment.js format tokens** are the canonical date/time formatting language (Daily notes, Templates, Unique note creator, Bases `date.format()`).
3. **Search syntax** is the shared query language: Search pane, embedded `query` blocks, Backlinks filter, Graph filters/groups, Tags view, Properties view drill-down, bookmarkable searches.
4. **Fuzzy matching** semantics are shared by Command palette, Slash commands, and Quick switcher (incl. the v1.8.3 recency-vs-brevity ranking rule and the >10,000-item simplified algorithm for the switcher).
5. **Sidebar view pattern**: Backlinks, Outgoing links, Outline, Tags, Properties (×2), Footnotes, Bookmarks, Search are all toggleable sidebar leaf views with a corresponding "Show …" command.
6. **Paid services** (Sync, Publish) need only client-side surfaces in the clone: settings panes, the Publish-changes modal, version-history browser, status indicator.
7. Items marked "verify in-app" are real behaviors not specified by the official help pages; confirm against the running app before implementing, and do not treat the parenthetical notes as documented spec.

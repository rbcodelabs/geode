# 04 — File Formats, Vault Internals, and Platform Behavior

Research compiled 2026-06-10 from official Obsidian sources: `help.obsidian.md` (now served at `obsidian.md/help/...` — the old `help.obsidian.md/<path>` URLs 301-redirect), `docs.obsidian.md` (developer docs), `jsoncanvas.org` (the open JSON Canvas spec Obsidian published), `obsidian.md/changelog`, `obsidian.md/pricing`, `obsidian.md/sync`, and `obsidian.md/publish`.

Provenance notes are flagged inline: **[documented]** = stated verbatim in official docs; **[observed]** = stable, widely-known on-disk behavior of the shipping app that official docs do not enumerate (safe to treat as de-facto format, but verify against a live vault before freezing the Geode spec).

---

## 1. Vault Internals: the `.obsidian` Directory

### 1.1 Vault model **[documented]**

- A **vault** is "a folder on your local file system, including any subfolders." Notes are "Markdown-formatted plain text files."
- Obsidian watches the filesystem: edits made by external editors are picked up automatically.
- Multiple folders can be opened as separate vaults; each vault is fully independent.
- Obsidian creates a `.obsidian` folder in the vault root containing **vault-specific** preferences (docs explicitly call out hotkeys, themes, community plugins, and the workspace files).

### 1.2 Config folder override **[documented]**

- Settings → **Files and Links → Override config folder** lets the user rename `.obsidian` to any dot-prefixed name (e.g. `.obsidian-awesome`); requires app relaunch.
- Settings do **not** migrate to the new folder automatically; the old folder is left in place.
- Primary use case: keeping separate device-specific configs while using a third-party file syncing service.
- Access on mobile: iOS/iPadOS has no built-in way to see the folder (third-party file apps like Taio/Textastic needed); Android requires "Show hidden files" in the file manager.

### 1.3 Per-vault vs. global settings **[documented]**

Per-vault settings live in `<vault>/.obsidian/`. **Global** (per-machine, per-OS-user) settings live outside the vault:

| OS | Global settings location |
|---|---|
| macOS | `~/Library/Application Support/obsidian` |
| Windows | `%APPDATA%\Obsidian\` |
| Linux | `$XDG_CONFIG_HOME/obsidian/` or `~/.config/obsidian/` |

Global state includes the vault list/registry (`obsidian.json` **[observed]**), license/Catalyst info, window state, and the app updater cache. Additionally, Obsidian keeps an **IndexedDB** per vault — "a low-level, client-side database" that stores the **metadata cache** (powers Graph, Outline, backlinks, search) and Obsidian Sync connection state. The cache can be rebuilt from settings; it is derived data, never the source of truth. **[documented]**

### 1.4 File inventory of `.obsidian/`

Official help does not publish an exhaustive schema for these files; the inventory below is the de-facto format of current Obsidian. Everything is JSON. Files are created lazily — a fresh vault contains only a few of them; each appears when the corresponding feature/plugin is first configured.

| File | Owner | Contents |
|---|---|---|
| `app.json` | Core | General editor/files settings **[observed]** |
| `appearance.json` | Core | Theme, fonts, CSS snippet toggles **[observed]** |
| `core-plugins.json` | Core | Enabled/disabled state of core plugins **[observed]** |
| `community-plugins.json` | Core | Array of enabled community plugin IDs **[observed]** |
| `hotkeys.json` | Core | User hotkey overrides only (deltas from defaults) **[observed]** |
| `workspace.json` | Core | Current window/pane layout; "store[s] the current workspace layout and update[s] whenever you open a new file" **[documented]** |
| `workspaces.json` | Workspaces core plugin | Named saved layouts **[documented name]** |
| `graph.json` | Graph view | Graph display settings (filters, groups, forces) **[observed]** |
| `canvas.json` | Canvas plugin | Canvas plugin settings (snap-to-grid etc.) **[observed]** |
| `types.json` | Properties | Vault-wide property-name → property-type assignments **[observed]** (help docs confirm the behavior: "Once a property type is assigned to a property name, all properties with that name across your vault will use the same type" — `types.json` is where that assignment persists) |
| `bookmarks.json` | Bookmarks core plugin | Bookmark tree (files, folders, searches, headings, blocks, graphs) **[observed]** |
| `daily-notes.json` | Daily notes core plugin | Date format, folder, template path **[observed]** |
| `templates.json` | Templates core plugin | Template folder, date/time formats **[observed]** |
| `backlink.json`, `page-preview.json`, `switcher.json`, `command-palette.json`, `zk-prefixer.json`, `note-composer.json`, `file-recovery.json`, `sync.json`, `publish.json` | Per core plugin | Each core plugin persists its own settings file named after the plugin **[observed pattern]** |

Subdirectories:

| Directory | Contents |
|---|---|
| `.obsidian/plugins/<plugin-id>/` | One folder per community plugin: `main.js`, `manifest.json`, optional `styles.css`, and `data.json` (the plugin's saved settings) **[documented in developer docs]** |
| `.obsidian/themes/<Theme Name>/` | `theme.css` + `manifest.json`; "the name of the theme directory must exactly match the `name` property in `manifest.json`" **[documented]** |
| `.obsidian/snippets/` | Loose `*.css` files toggled individually in Settings → Appearance **[documented behavior]** |

Example shapes **[observed — verify against a live vault]**:

```json
// .obsidian/community-plugins.json
["dataview", "obsidian-git", "templater-obsidian"]
```

```json
// .obsidian/hotkeys.json — only overrides are stored
{
  "editor:toggle-bold": [{ "modifiers": ["Mod"], "key": "B" }],
  "app:toggle-left-sidebar": []
}
```

```json
// .obsidian/types.json
{
  "types": {
    "due": "date",
    "rating": "number",
    "done": "checkbox",
    "related": "multitext"
  }
}
```

```json
// .obsidian/daily-notes.json
{ "format": "YYYY-MM-DD", "folder": "Daily", "template": "Templates/Daily" }
```

`workspace.json` stores a recursive split/tabs tree: a root `main` split containing `tabs` groups whose children are leaf views (`type`: `markdown`, `canvas`, `graph`, ...) plus `left`/`right` sidebar trees, `active` leaf id, and `lastOpenFiles`. **[observed]**

### 1.5 Properties / frontmatter format **[documented]**

Properties are YAML frontmatter delimited by `---` at the top of the file. "Property names are separated from their values by a colon followed by a space." Names are unique per note.

Property types (assigned vault-wide per property name):

| Type | Format / notes |
|---|---|
| Text | Single-line; markdown not rendered; "Hashtags do not create tags when used in text properties"; internal links allowed but "must be surrounded with quotes" |
| List | YAML sequence (`- item` per line) |
| Number | "must always be a literal number, not an expression"; ints and decimals |
| Checkbox | `true`/`false` |
| Date | `YYYY-MM-DD`; rendered per OS locale; acts as a link to the daily note when Daily notes is enabled |
| Date & time | `YYYY-MM-DDTHH:MM:SS` |
| Tags | Special list type reserved for the `tags` property only |

Default properties: `tags`, `aliases`, `cssclasses` (all lists). Publish-specific properties: `publish`, `permalink`, `description`, `image`, `cover`. Deprecated singular forms `tag`/`alias`/`cssclass` were deprecated in v1.4 and **dropped in v1.9**.

JSON frontmatter is accepted as input and rewritten as YAML:

```json
---
{ "tags": ["journal"], "publish": false }
---
```

Intentional limitations: no nested properties (source-mode only), no markdown rendering in values, no built-in bulk editing. As of v1.11, **Markdown links are supported in text and list properties** (changelog).

---

## 2. JSON Canvas Format (`.canvas`)

Source: jsoncanvas.org — "An open file format for infinite canvas data." Created by Obsidian (announced with Obsidian 1.5-era Canvas), version **1.0**, **MIT licensed**, extension `.canvas`. Design goals: "longevity, readability, interoperability, and extensibility."

### 2.1 Top level

A `.canvas` file is a single JSON object with two optional arrays:

```json
{ "nodes": [], "edges": [] }
```

`nodes` are ordered by z-index: first = bottom, last = top.

### 2.2 Nodes

All nodes share:

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique identifier |
| `type` | string | yes | `text` \| `file` \| `link` \| `group` |
| `x`, `y` | integer | yes | Position in pixels |
| `width`, `height` | integer | yes | Size in pixels |
| `color` | canvasColor | no | See §2.4 |

Per-type additions:

- **`text`** — `text` (string, required): "plain text with Markdown syntax."
- **`file`** — `file` (string, required): path to the file within the system; `subpath` (string, optional): heading/block reference, always starts with `#` (e.g. `#Heading`, `#^block-id`).
- **`link`** — `url` (string, required).
- **`group`** — `label` (string, optional); `background` (string, optional, image path); `backgroundStyle` (string, optional): `cover` | `ratio` | `repeat`.

### 2.3 Edges

| Attribute | Type | Required | Values / default |
|---|---|---|---|
| `id` | string | yes | |
| `fromNode` / `toNode` | string | yes | Node ids |
| `fromSide` / `toSide` | string | no | `top` \| `right` \| `bottom` \| `left` |
| `fromEnd` / `toEnd` | string | no | `none` \| `arrow`; defaults: `fromEnd: none`, `toEnd: arrow` |
| `color` | canvasColor | no | |
| `label` | string | no | |

### 2.4 Color (`canvasColor`)

Either a hex string (`"#FF0000"`) or a preset string `"1"`–`"6"`: 1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple. Preset values are "intentionally undefined" in exact rendering so apps can theme them.

### 2.5 Example

```json
{
  "nodes": [
    { "id": "a1", "type": "text", "text": "# Idea\nSome **markdown**", "x": -200, "y": -100, "width": 360, "height": 180, "color": "4" },
    { "id": "b2", "type": "file", "file": "Notes/Plan.md", "subpath": "#Goals", "x": 300, "y": -100, "width": 400, "height": 300 },
    { "id": "c3", "type": "link", "url": "https://jsoncanvas.org", "x": 300, "y": 260, "width": 400, "height": 240 },
    { "id": "g1", "type": "group", "label": "Research", "x": -260, "y": -160, "width": 1040, "height": 720, "backgroundStyle": "cover" }
  ],
  "edges": [
    { "id": "e1", "fromNode": "a1", "fromSide": "right", "toNode": "b2", "toSide": "left", "toEnd": "arrow", "color": "#888888", "label": "expands on" }
  ]
}
```

---

## 3. Bases Format (`.base`)

Bases is "a core plugin that lets you create database-like views of your notes" (introduced v1.9, May 2025). Crucially: "All the data in Obsidian Bases is stored in your local Markdown files and their properties" — the `.base` file is only a **view definition**, in YAML. Views can also be embedded as ` ```base ` code blocks inside Markdown notes, and a saved base embeds with `![[File.base]]` or `![[File.base#ViewName]]`.

### 3.1 Top-level keys

| Key | Purpose |
|---|---|
| `filters` | Global filter applied to all views |
| `formulas` | Named computed properties shared by all views |
| `properties` | Per-property display config (e.g. `displayName`) |
| `summaries` | Custom aggregation formulas |
| `views` | Array of view definitions |

### 3.2 Full example (from help docs, verbatim structure)

```yaml
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")

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

### 3.3 Filters

- Boolean combinators `and` / `or` / `not` take heterogeneous lists of filter statements or nested combinators.
- Filter statements are expressions evaluating to true/false: comparisons (`==`, `!=`, `>`, `<`, `>=`, `<=`), inline boolean operators (`!`, `&&`, `||`), or boolean-returning functions (`file.hasTag()`, `file.hasLink()`, `file.inFolder()`).
- View-level `filters` are AND-ed onto the global `filters`.

Property namespaces:
- `note.<prop>` or bare `<prop>` — frontmatter properties
- `file.<field>` — intrinsic file data: `name`, `basename`, `path`, `folder`, `ext`, `size`, `properties`, `tags`, `links`, `ctime`, `mtime` (plus `file.backlinks`, added v1.9.7)
- `formula.<name>` — formulas defined in the file

### 3.4 Views

View object keys: `type` (built-in or plugin-provided), `name`, `limit` (row cap), `groupBy` (`property` + `direction: ASC|DESC`; one property only), `filters`, `order` (column/property ordering), `summaries` (property → aggregation name).

Built-in view types:

| Type | Since | Description |
|---|---|---|
| `table` | 1.9 | "Display files as rows in a table. Columns are populated from properties." Row-height option; column summaries; multi-row paste from Excel/Sheets; copy/CSV export |
| `cards` | 1.9.3 | "Gallery-like views with images"; optional cover-image property; card-size slider |
| `list` | 1.10 | Bulleted/numbered/no markers; selected properties render as indented sub-items |
| `map` | 1.10 | "Display files as pins on an interactive map. Requires the Maps plugin" |

Sorting: one or more properties asc/desc, type-aware (alphabetical/numerical/temporal). Views can be renamed (links/embeds auto-update since 1.10.2). Canvas can embed a base and "Pin view" (1.9.5). A Bases API for plugin-defined view types shipped with 1.10.

Built-in summary aggregations: numeric — Average, Min, Max, Sum, Range, Median, Stddev; date — Earliest, Latest, Range; boolean — Checked, Unchecked; any — Empty, Filled, Unique.

### 3.5 Formula syntax

- Expression language with arithmetic `+ - * / % ( )`, string concatenation via `+`, date arithmetic with duration strings (`date + "1M"`, `date - "2h"`).
- Object-oriented and chainable (`price.toFixed(2)`, `values.mean().round(3)`) — this OO syntax was a **breaking change in 1.9.2**; functions were renamed snake_case → camelCase in 1.9.1.
- String literals in single or double quotes inside YAML strings.

### 3.6 Function reference (complete as of 1.13)

**Global:** `escapeHTML(html)`, `date(string)`, `duration(string)`, `file(path)`, `html(string)`, `if(cond, true, false?)`, `image(path)`, `icon(name)` (Lucide), `link(path, display?)`, `list(any)`, `max(...)`, `min(...)`, `now()`, `number(any)`, `today()`, `random()`

**Any:** `isTruthy()`, `isType(type)`, `toString()`

**String:** `contains`, `containsAll`, `containsAny`, `endsWith`, `isEmpty`, `lower`, `replace(pattern|Regexp, replacement)`, `repeat(n)`, `reverse`, `slice(start, end?)`, `split(sep|Regexp, n?)`, `startsWith`, `title`, `trim`; field `length`

**Number:** `abs`, `ceil`, `floor`, `isEmpty`, `round(digits)`, `toFixed(precision)`

**Date:** `date()` (strip time), `format(momentFormat)`, `time()`, `relative()`, `isEmpty()`; fields `year month day hour minute second millisecond`

**List:** `contains`, `containsAll`, `containsAny`, `filter(expr)`, `flat`, `isEmpty`, `join(sep)`, `map(expr)`, `reduce(expr, acc)`, `reverse`, `slice`, `sort`, `unique`; field `length`

**Link:** `asFile()`, `linksTo(file)`

**File:** `asLink(display?)`, `hasLink(otherFile)`, `hasProperty(name)`, `hasTag(...values)`, `inFolder(folder)`; fields listed in §3.3

**Object:** `isEmpty()`, `keys()`, `values()`

**Regexp:** `matches(value)`

---

## 4. Obsidian URI Scheme (`obsidian://`)

All parameter values must be URI-encoded (`/` → `%2F`, space → `%20`). Heading/block targets are encoded into `file`: `Note%23Heading`, `Note%23%5EBlock` (`#`, `#^`).

### 4.1 Actions

**`open`** — open vault or file
- `vault` — vault name or ID (omit to use most-recent vault)
- `file` — vault-relative path; `.md` optional
- `path` — absolute filesystem path (overrides `vault`+`file`)
- `prepend` / `append` — add content at top/bottom; merges properties
- `paneType` — `tab` | `split` | `window` (desktop only; added 1.11.2)
- `x-success`, `x-error` — x-callback-url

**`new`** — create note
- `vault`; `name` (respects default new-note location); `file` (vault-relative path incl. filename); `path` (absolute)
- `content` — note body; `clipboard` — use clipboard contents instead
- `silent` — create without opening; `append` — append if file exists; `overwrite` — replace if exists (ignored when `append` set)
- `paneType`; `x-success`

**`daily`** — open/create today's daily note (requires Daily notes plugin). Accepts all `new` parameters.

**`unique`** — create unique note (requires Unique note creator plugin): `vault`, `paneType`, `content`, `clipboard`, `x-success`.

**`search`** — open search: `vault`, `query`.

**`choose-vault`** — opens the vault manager/switcher (added ~1.11.7).

**`hook-get-address`** — Hook app integration: `vault` (optional), `x-success`, `x-error`.

### 4.2 Shorthands

```
obsidian://vault/my vault/my note      ≡ obsidian://open?vault=my%20vault&file=my%20note
obsidian:///absolute/path/to/note     ≡ obsidian://open?path=%2Fabsolute%2Fpath%2Fto%2Fnote
```

### 4.3 x-callback-url responses

With `x-success`, the callback receives: `name` (filename w/o extension), `url` (an `obsidian://` URI), `file` (a `file://` URL, desktop only).

### 4.4 Registration & security

- Windows/macOS: protocol registered on first launch. Linux: needs `obsidian.desktop` with `Exec=executable %u`; AppImage may require unpacking.
- Since **1.13**, incoming URIs show a confirmation dialog with an allow-list. **[changelog]**

---

## 5. Obsidian Sync (add-on service)

"An add-on service that allows you to privately sync your notes across devices" via an off-site **remote vault**; every device keeps a full local copy.

### 5.1 Plans & limits

| Feature | Standard | Plus |
|---|---|---|
| Price | $4/user/mo annual, $5 monthly | $8/user/mo annual, $10 monthly |
| Synced vaults | 1 | 10 |
| Total storage (account-wide) | 1 GB | 10 GB, purchasable up to 100 GB |
| Max file size | 5 MB | 200 MB |
| Version history | 1 month | 12 months |
| Devices | Unlimited | Unlimited |
| Shared (collaborative) vaults | Yes | Yes |

Version history and attachments count toward storage. When over quota, sync halts and prompts for cleanup. 40% education/non-profit discount.

### 5.2 Encryption **[documented]**

- **End-to-end (default):** AES-256 in **GCM** mode; key derived from a user-held encryption password via **scrypt with salt**. "The data is encrypted from the moment it leaves your device, and can only be decrypted using your encryption key." Lost password = unrecoverable data.
- **Standard encryption (optional):** key managed by Obsidian; protects in transit and at rest, comparable to "Google Docs, Dropbox, and iCloud (without Advanced Data Protection)."
- Encrypted: remote vault contents and all server communication. **Not** encrypted: local vault; and some metadata — "which device uploaded or deleted a file, when it was uploaded, and the mapping between encrypted file paths and encrypted content."
- File-name encryption strengthened to **AES-SIV** in 1.9.11 (Aug 2025); a migration assistant for encryption upgrades and region switching shipped in 1.9.12.
- Servers: DigitalOcean in 4 regions — Singapore, Frankfurt, San Francisco, Sydney. Third-party security audit completed (report on the Security page).

### 5.3 Selective sync **[documented]**

- File-type toggles: **Images, Audio, Videos, PDFs**, plus a "Sync all other types" toggle for everything else.
- **Excluded folders** list (Settings → Sync → Excluded folders → Manage). Caveat: "Adding a file to the Excluded files list does not remove it from the remote vault if it has already been synced."
- Always excluded: File Recovery snapshots; hidden dot-files/folders (`.git`, `.vscode`, ...) — **except `.obsidian`, which does sync**.
- Vault-config sync categories (defaults): Main settings, Appearance, Themes and snippets, Hotkeys, Active core plugin list, Core plugin settings. Opt-in: Active community plugin list, Installed community plugins. "Sync settings do not sync across devices" — configured per device.
- Conflict handling: "Conflict resolution" setting (1.9.7) — merge vs. conflict-file creation. Collaboration: Sync History view (1.7), "Hide my changes" (1.8).

### 5.4 Third-party sync alternatives **[documented]**

iOS/iPadOS officially supports only Obsidian Sync and iCloud (vault must live at `iCloud Drive/Obsidian/<Vault>`); "iCloud Drive on Windows may lead to file duplication or corruption." Google Drive: no iOS support; OneDrive: limited Android; Syncthing/Git are community paths. Mixing multiple sync services risks corruption; cloud "Files On-Demand"/offloading breaks Obsidian.

---

## 6. Obsidian Publish (add-on service)

"A cloud-based hosting service that lets you publish your notes as a wiki, knowledge base, documentation, or digital garden" at `publish.obsidian.md/<your-site>`. **$8/site/mo annual, $10 monthly**; hosting up to **4 GB**; 7-day refund; 40% edu/non-profit discount.

### 6.1 Components & reading experience

- **Graph view** — "Visually explore the connections between the pages on your site"
- **Backlinks** — "Automatically list links to pages that reference the current page"
- **Outline / table of contents**, **search** (full-text since 2024-03), **hover previews**, **stacked pages** (horizontal sliding panes)
- All toggleable per-site under Site options → Reading experience / Components.

### 6.2 Customization

- `publish.css` published to vault root → full custom styling; community theme CSS can be renamed to `publish.css`.
- `publish.js` for custom JavaScript — **requires a custom domain**.
- Favicons: publish `favicon-32x32.png`, `favicon.ico`, etc., anywhere in the vault.
- Navigation: reorder, hide/unhide sidebar items, restore alphabetical default.
- "First-class SEO", customizable metadata; optional Google Analytics or privacy-friendly alternatives (Plausible, Fathom). Publish sites score "100% Lighthouse accessibility" by default.

### 6.3 Frontmatter controls

`publish` (include/exclude), `permalink` (custom slug: turns `/username/Company/About+us` into `/username/about`; old URL auto-redirects), `description`, `image`/`cover` (social metadata). Redirects for moved/deleted notes: add the old note's **full path** to the destination note's `alias`/`aliases` property.

### 6.4 Password protection & domains

- Site-wide password(s): Publish changes → Change site options → Other site settings → Passwords → Manage; multiple passwords supported; removing all makes the site public. **Per-note passwords are not supported.**
- Custom domains: CNAME to `publish-main.obsidian.md` ("Don't include your personal sub-URL"); **Cloudflare is "the only officially supported provider"** (proxy on, SSL mode "Full"). Obsidian does not provision SSL certificates.
- Subpath hosting via reverse proxy to `https://publish.obsidian.md/serve?url=yourdomain.com/path/` (documented configs for NGINX, Apache, Netlify, Vercel, Caddy, Traefik), or the `x-obsidian-custom-domain` header.

---

## 7. Platform Matrix

| | Desktop | Mobile |
|---|---|---|
| OSes | Windows, macOS, Linux | iOS/iPadOS, Android |
| Runtime | **Electron** (Chromium + Node.js) | **Capacitor** WebView (WKWebView on iOS) — same core web codebase |
| Node.js / Electron APIs | Available to plugins | **Not available** — "Any calls to these libraries... can cause your plugin to crash"; plugins can set `isDesktopOnly: true` in manifest |
| Platform detection | `Platform.isIosApp`, `Platform.isAndroidApp`; desktop can emulate mobile via `this.app.emulateMobile(true)` | same API |
| URI `paneType` | `tab` / `split` / `window` | Not supported (desktop only) |
| `.obsidian` access | Normal hidden folder | iOS: needs 3rd-party file app; Android: "show hidden files" |
| Storage | Anywhere on disk | Android 1.8.10+: works without "All files" permission using app-private storage; iOS: local or `iCloud Drive/Obsidian/` |
| JS engine caveats | — | Regex lookbehind requires iOS 16.4+; remote debugging: Chrome DevTools (`chrome://inspect`) on Android, Safari Web Inspector on iOS 16.4+/macOS |
| Mobile-only UX (1.11–1.13) | — | iOS Lock Screen/Control Center/Home Screen widgets, Siri + Spotlight actions, iOS Share Sheet (1.12.4/1.13); Android widgets + Quick Settings Tile; auto-hiding navigation, full-screen mode, tab switcher; shake-to-debug (1.10) |
| CLI | Obsidian CLI binary bundled since 1.12 (autocompletion 1.12.5+) | n/a |

Feature parity is otherwise near-total: editor, Canvas, Bases, properties, plugins all run on mobile.

---

## 8. Feature Evolution — Changelog Scan (mid-2024 → June 2026)

Current version at time of writing: **1.13.1** (June 9, 2026). The changelog at `obsidian.md/changelog` paginates (24 pages); below are the major-feature milestones a current-Obsidian clone must target.

| Version | Date | Headline features |
|---|---|---|
| 1.5.x | Feb–Mar 2024 | Table editor maturity: auto-formatting while typing, mobile table editor, RTL in tables, drag-drop into cells; "Save layout" command; Publish full-text search (2024-03) |
| **1.6** | May–Jun 2024 | RTL language support w/ per-line direction detection; redesigned left sidebar + vault profile/switcher; hideable ribbon; selection-aware word count; footnote hover previews + `[^` autocomplete; better Sync defaults; editor parsing performance |
| **1.7** | Aug–Oct 2024 | **Deferred-view lazy workspace loading** (faster startup); editable page previews; Sync History view; mobile tab switcher; app load-time monitoring screen |
| **1.8** | Dec 2024–Jan 2025 | **Web viewer** core plugin (in-app browser, "Save to vault"); Sync "Hide my changes"; auto-reveal file in explorer; insert-footnote command; download-attachments command; guided mobile onboarding |
| **1.9** | May–Sep 2025 | **Bases** core plugin (tables, filters, formulas; Cards view 1.9.3; formula editor 1.9.5; OO formula syntax 1.9.2); **Footnotes view** core plugin; dropped `tag`/`alias`/`cssclass`; Sync AES-SIV filename encryption + migration assistant |
| **1.10** | Oct–Nov 2025 | Bases: Group by, summaries, **List view**, **Maps plugin/view**, Bases API, keyboard nav + copy/paste, CSV-ish paste from Excel/Sheets; toggle light/dark command; mobile shake-to-debug |
| **1.11** | Dec 2025–Feb 2026 | **Markdown links in text/list properties**; predefined daily-note formats; **Keychain** (encrypted secret storage for plugins, at-rest encryption 1.11.5); URI `paneType` + `choose-vault`; auto plugin-update checks; mobile: iOS widgets/Siri/Spotlight, Android widgets, interface refresh, full-screen mode, Restricted Mode per-vault |
| **1.12** | Feb–Mar 2026 | **Obsidian CLI** (terminal control/scripting, bundled binary, autocompletion); image drag-resize in Live Preview; automatic attachment cleanup on delete; Bases search toolbar; iOS Share extension; system-language onboarding |
| **1.13** | May–Jun 2026 | **Settings overhaul**: separate window, built-in search, keyboard navigation; URI confirmation dialogs + allow-list; Bookmarks search; drag-drop folder import preserving structure; Note Composer link rewriting; Sync view file drag + search; mouse back-button navigation |

Pre-2024 context (for completeness): Canvas (1.1, 2022), Properties UI (1.4, Jul 2023), new CM6 editor/Live Preview (1.0/1.5 era), Table editor (1.5, Dec 2023).

---

## 9. Licensing & Commercial Model (what the OSS clone replaces)

- **App is free** for both personal **and** commercial use — "No sign-up required. No strings attached." Commercial users are *encouraged*, not required, to buy a license. The app itself is **proprietary/closed-source** (this is the gap an OSS clone fills); the formats (Markdown, JSON Canvas/MIT) are open.
- **Catalyst** — $25 one-time supporter license: early beta ("Insider") builds, community badges, VIP channels.
- **Commercial license** — $50/user/year, optional, for organizational use; non-refundable.
- **Sync** — $4–5 (Standard) / $8–10 (Plus) per user/month (see §5).
- **Publish** — $8–10 per site/month (see §6).
- 40% discount on Sync/Publish for students, faculty, non-profit employees; 7-day refunds for Sync/Publish only.

For Geode: the clone replaces the free app; Sync ≈ any E2E file-sync backend honoring §5 semantics; Publish ≈ static-ish hosted rendering honoring §6 components.

---

## 10. Performance & Accessibility

### 10.1 Performance characteristics (as documented/changelog)

Obsidian publishes no hard vault-size guarantees; documented performance commitments are incremental:

- Metadata cache in IndexedDB persists across launches so big vaults don't re-index on every start; manual "rebuild cache" option (1.6.5).
- 1.6: "improved editor parsing performance" and faster workspace loading; 1.7: deferred (lazy) view loading — tabs hydrate on focus, plus a load-time monitoring screen in settings showing per-plugin startup cost.
- 1.9.13/1.9.14: Quick Switcher / Command Palette performance for large vaults; 1.10.3 mobile: faster launch by opening last file in background; 1.5.9: faster community plugin/theme browsing.
- Sync practical scale bounds come from plan limits (§5.1), not engine limits.
- Implication for Geode: lazy view instantiation + persistent derived-metadata cache are the two load-bearing performance architecture features to replicate.

### 10.2 Accessibility

There is **no dedicated accessibility page** in official help (the `accessibility` slug 404s) — a documentation gap worth noting. Documented accessibility-relevant capabilities:

- Full RTL interface mirroring and per-line text-direction detection (1.6+).
- Extensive hotkey customization (every command bindable; `hotkeys.json`); 1.13 adds full keyboard navigation of settings, Alt-Arrow reordering, searchable settings.
- Bases full keyboard navigation (1.10); themes/CSS snippets allow arbitrary contrast/font adjustments; system-default font options (1.5.11); adjustable base font size and zoom.
- Obsidian **Publish** sites: "100% Lighthouse accessibility score by default."
- Community forum threads document ongoing screen-reader gaps (NVDA blank-text issues, unlabeled buttons) — an area where an OSS clone can differentiate.

---

## Source Index

- JSON Canvas: https://jsoncanvas.org / https://jsoncanvas.org/spec/1.0/
- Help (new base URL `https://obsidian.md/help/...`): configuration-folder; Files and folders/How Obsidian stores data; Editing and formatting/Properties; bases, bases/syntax, bases/functions, bases/views; Extending Obsidian/Obsidian URI; sync/settings; Obsidian Sync/Security and privacy; Obsidian Sync/Plans and storage limits; publish/domains, publish/permalinks, publish/security; Getting started/Sync your notes across devices
- Developer docs: https://docs.obsidian.md (Mobile development; Build a theme)
- Marketing/commerce: https://obsidian.md/pricing, /sync, /publish, /changelog (pages 1–9 scanned, v1.5.8 → v1.13.1)

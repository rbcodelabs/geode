# Parity triage — October 2026

Evidence-backed assessment of the `help-page` (179) and `changelog-delta` (50) rows of the
Obsidian parity ledger. Developer-page and API rows (`developer-page`, `api-declaration`,
`api-member`) were **not** touched in this pass (priority 3, not started).

Method: read-only. Each row was assessed against the upstream page, `src/`, `tests/unit` and
`tests/e2e` by delegated reviewers; the lead spot-checked the highest-impact `missing` claims
(Vim, Outgoing links, Properties view, Workspaces, File Recovery, PDFs, folding, multi-cursor,
pop-out windows, CSS snippets, lightbox) with independent greps of `src/`. No e2e suite was run.
Rows were scored conservatively: **no help/changelog row is `verified` on the strength of this pass
alone except where a unit/e2e test was read and asserts the behavior** (3 rows in total).

## Before / after

Before:

| kind | verified | partial | intentionally-equivalent | missing | blocked | unknown | total |
|---|---|---|---|---|---|---|---|
| api-declaration | 44 | 9 | 0 | 0 | 0 | 248 | 301 |
| api-member | 152 | 16 | 0 | 0 | 1 | 845 | 1014 |
| changelog-delta | 0 | 0 | 0 | 0 | 0 | 50 | 50 |
| developer-page | 132 | 22 | 0 | 0 | 0 | 1165 | 1319 |
| help-page | 0 | 8 | 0 | 0 | 0 | 171 | 179 |
| **all** | 328 | 55 | 0 | 0 | 1 | 2479 | 2863 |

After:

| kind | verified | partial | intentionally-equivalent | missing | blocked | unknown | total |
|---|---|---|---|---|---|---|---|
| api-declaration | 44 | 9 | 0 | 0 | 0 | 248 | 301 |
| api-member | 152 | 16 | 0 | 0 | 1 | 845 | 1014 |
| changelog-delta | 0 | 2 | 0 | 30 | 12 | 6 | 50 |
| developer-page | 132 | 22 | 0 | 0 | 0 | 1165 | 1319 |
| help-page | 3 | 75 | 5 | 24 | 66 | 6 | 179 |
| **all** | 331 | 124 | 5 | 54 | 79 | 2270 | 2863 |

Rows assessed this pass: 229. Of the 229, 66 out-of-scope-service help rows are `blocked`
with a note starting "out-of-scope service" (Publish, Web Clipper, Importer, Teams, Licenses,
Contributing, Obsidian about) — no implementation exists in the repo.

## Top 15 gaps, ranked by impact for a daily Obsidian user

| # | Gap | Size | Why it ranks here |
|---|---|---|---|
| 1 | **Properties view** (sidebar) and Properties editor UI (`Properties` page partial) | M/L | Properties are central to modern vaults and Bases; no sidebar view exists. |
| 2 | **Outgoing links** pane | M | Core daily-nav pane; Backlinks exists, this is its sibling. |
| 3 | **Folding** (headings/lists) | M | Spec lists it; no fold gutter in `src/`. Heavily used in long notes. |
| 4 | **Multiple cursors / rectangular selection** | M | CodeMirror supports it; needs enabling plus tests. |
| 5 | **PDF viewer / `![[x.pdf#page=N]]` embeds** | L | Very common attachment type; only extension classification exists. |
| 6 | **Image lightbox / zoom / pan / Live Preview image selection & resize** (1.13.2–1.13.4, ~15 rows) | L | Whole new image-interaction model; largest changelog cluster. |
| 7 | **File Recovery** (snapshots, recovery modal, keyboard nav) | L | Safety-net feature users rely on; Geode has append-only sync history but no UI. |
| 8 | **Workspaces** plugin (save/load named layouts) | M | Missing core plugin. |
| 9 | **CSS snippets** (loader + Appearance UI) | M | Theming staple for power users. |
| 10 | **Version history** (Sync) | L | Closest Geode equivalent to history; needs UI over append-only history. |
| 11 | **Vim mode** (`:image`, ghost character rows) | L | No Vim keybindings anywhere in `src/`; passionate user segment. |
| 12 | **Pop-out windows** | L | `getLeaf('window')` explicitly throws; multi-monitor users. |
| 13 | **Footnotes view** | M | Missing core plugin. |
| 14 | **HTML content / embed web pages** (iframes) | M | Reading view strips iframes; breaks YouTube etc. embeds. |
| 15 | **Page Preview settings, pinned commands, code-block Copy button** (1.13.x small fixes) | S each | Cheap, visible polish; closes ~6 changelog rows. |

Next tier: Bases List/Map/Kanban views, Language settings (i18n), Graph filters/groups/forces,
Restricted Mode / plugin security, Community directory, Daily-notes/Templates/Quick-switcher e2e coverage.

## Full gap list — help pages (missing / partial)

Size = rough effort of the closing PR (S ≤ 1 day, M a few days, L a week+). Rows in `partial`
mostly need an e2e (tests/e2e) to promote, sometimes plus a small implementation gap.
Out-of-scope services are excluded (they are `blocked`).

### Bases

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | M | List view (`HELP-7ca13a31b6db`) | implement List layout and e2e |
| missing | L | Map view (`HELP-f067e7098577`) | implement Map layout or certify Maps plugin and e2e |
| partial | M | Bases syntax (`HELP-684bd6de7d85`) | e2e/unit for remaining syntax keys and namespaces |
| partial | S | Cards view (`HELP-0b295d02a8ac`) | e2e for cover image and card settings UI |
| partial | S | Create a base (`HELP-9f1cbe3c3862`) | e2e for palette commands, ribbon, Insert new base |
| partial | S | Formulas (`HELP-a87d558db1d7`) | e2e for formula authoring UI |
| partial | M | Introduction to Bases (`HELP-b8af5770f86a`) | e2e for export, search, New and remaining toolbar |
| partial | L | Kanban view (`HELP-cd06d684e91a`) | implement built-in Kanban view plus e2e |
| partial | M | Table view (`HELP-86f15061a63b`) | e2e for row height and summary UI |
| partial | M | Views (`HELP-cb320429ffad`) | e2e for view menu management and group menu |

### Editing and formatting

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | M | Embed web pages (`HELP-5c9a9b00d336`) | implement iframe embed rendering and e2e |
| missing | M | Folding (`HELP-7ada99e267bd`) | implement folding and e2e |
| missing | M | HTML content (`HELP-b47562055c69`) | implement HTML block rendering and e2e |
| missing | M | Multiple cursors (`HELP-6fe9c0ba52bd`) | enable and e2e-test multi-cursor and rectangular selection |
| partial | S | Advanced formatting syntax (`HELP-c423322a978d`) | e2e for Reading View tables |
| partial | M | Attachments (`HELP-8001bece33fe`) | tests for non-image attachment add and settings UI |
| partial | M | Basic formatting syntax (`HELP-6b3f00a87c91`) | e2e/unit rendering sweep of basic syntax |
| partial | S | Callouts (`HELP-3b05eed66494`) | e2e for fold toggle, nesting, custom types |
| partial | M | Obsidian Flavored Markdown (`HELP-2c035cca4cfb`) | OFM syntax sweep e2e |
| partial | L | Properties (`HELP-4df0a02a2c6e`) | implement property editor UI and e2e |
| partial | M | Tags (`HELP-bd4f0f0a0c74`) | e2e for tag click search and Tags view |
| partial | S | Views and editing mode (`HELP-f24d48df04dd`) | e2e for Cmd+E, defaults and indicator |

### Extending Obsidian

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | M | CSS snippets (`HELP-cfd1b4579749`) | implement snippet loader + settings UI + e2e |
| missing | L | Community directory (`HELP-eebcb15eaef3`) | implement listing detail view + e2e |
| missing | L | Obsidian CLI (`HELP-47bffbd7e355`) | implement app-control CLI + e2e |
| partial | M | Community plugins (`HELP-1b0867830757`) | e2e for restricted mode, browse filter, funding/folder/reload controls |
| partial | M | Obsidian URI (`HELP-a909e072358d`) | implement built-in actions + e2e |
| partial | M | Plugin security (`HELP-b35b4ed150ff`) | implement Restricted Mode + e2e |
| partial | S | Themes (`HELP-472af3b11645`) | e2e theme update + uninstall |

### Files and folders

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | M | Symbolic links and junctions (`HELP-6670235e2ad5`) | support folder symlinks or document intentional refusal in ADR |
| partial | M | Accepted file formats (`HELP-a57aeb54bdfd`) | e2e for audio/video/PDF handling |
| partial | M | Configuration folder (`HELP-c0779b1697c9`) | implement config folder override and tests |
| partial | S | How Obsidian stores data (`HELP-14afb18687a7`) | tests for global settings location |
| partial | M | Manage notes (`HELP-a11d9a7fc207`) | e2e for create/delete/rename/move menus |
| partial | M | Manage vaults (`HELP-f79a2410db50`) | implement rename/move/remove vault and tests |

### General

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | M | Help and support (`HELP-db2b997aee35`) | implement Show debug info, Startup time, Sandbox vault |

### Getting started

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | L | Import notes (`HELP-54c715dbf604`) | implement importer(s) + e2e |
| partial | S | Create your first note (`HELP-37aa10df11b5`) | e2e for Mod+N rename + Mod+B |
| partial | M | Link notes (`HELP-8f0d1a29a831`) | e2e for [[ autocomplete, unresolved link create, local graph |
| partial | L | Mobile app (`HELP-06149f5bc237`) | implement mobile toolbar + mobile e2e |
| partial | S | Sandbox vault (`HELP-3e00e8be37ee`) | add command/help entry + e2e |
| partial | M | Update Obsidian (`HELP-1d4c4c81d072`) | e2e for settings update controls |

### Linking notes and files

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | L | PDFs (`HELP-8b73cda39c01`) | implement PDF viewer/embed and e2e |
| partial | S | Aliases (`HELP-32da8f2003a5`) | e2e for alias in suggester and quick switcher |
| partial | M | Embed files (`HELP-bbdab2fba109`) | e2e for note/heading/block, audio/video, PDF embeds |
| partial | M | Internal links (`HELP-b38cb786725c`) | e2e for link suggester and link format settings |

### Obsidian

| status | size | row | what a closing PR needs |
|---|---|---|---|
| partial | M | Obsidian for Android (`HELP-0fbb1a747f8a`) | e2e/spec mapping of mobile page claims |
| partial | M | Obsidian for iOS and iPadOS (`HELP-576b68aa5f3e`) | e2e/spec mapping of mobile page claims |

### Obsidian Sync

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | L | Collaborate on a shared vault (`HELP-f3d309882121`) | implement shared-vault membership/invite flow (or document hub-token model as equivalent) + e2e |
| missing | S | Switch to Obsidian Sync (`HELP-2cde397ae503`) | doc page / onboarding note; no code |
| missing | L | Upgrade Sync encryption (`HELP-2db6bdd5a3e8`) | only relevant if E2EE is implemented; otherwise record as intentionally-equivalent in ADR |
| missing | L | Version history (`HELP-d0b639894c6f`) | implement version-history view over append-only history + e2e |
| partial | M | Frequently asked questions (`HELP-c4ec99da7a83`) | document intentional divergences in an ADR; e2e for scope/file-type defaults |
| partial | M | Introduction to Obsidian Sync (`HELP-2a8631dad0f1`) | ADR mapping each Sync subpage to a Geode equivalent or gap |
| partial | S | Local and remote vaults (`HELP-09cef23e65b8`) | e2e/doc for offline queue wording and location guidance |
| partial | L | Security and privacy (`HELP-7c74210aa7ae`) | implement or formally defer E2EE in an ADR; e2e for key handling |
| partial | M | Set up Obsidian Sync (`HELP-75dcc5eaf1e9`) | e2e for second-device join + settings parity; account/E2EE N/A |
| partial | M | Status icon and messages (`HELP-53275b05d7fc`) | status bar icon + activity log e2e |
| partial | M | Sync settings and selective syncing (`HELP-e1b4a6e72831`) | e2e toggling each scope option and verifying remote effect |
| partial | M | Troubleshoot Obsidian Sync (`HELP-2b5cecd785a3`) | decide merge policy (ADR) + e2e |

### Plugins

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | L | File recovery (`HELP-8c92e46364f4`) | implement snapshot store + recovery modal + e2e |
| missing | M | Footnotes view (`HELP-bf850d16a524`) | implement Footnotes sidebar view + e2e |
| missing | M | Outgoing links (`HELP-71a13098c749`) | implement Outgoing links view (links + unlinked) + e2e |
| missing | M | Properties view (`HELP-eb3c5079b6e7`) | implement Properties sidebar view + e2e |
| missing | M | Workspaces (`HELP-334ff7cf3b4d`) | implement Workspaces plugin commands + e2e |
| partial | M | Audio recorder (`HELP-eab17f7eff0f`) | e2e with fake media device covering ribbon, command and embed |
| partial | M | Backlinks (`HELP-d6b3f1f19c87`) | e2e for linked/unlinked lists and pane options |
| partial | S | Bookmarks (`HELP-59b4d64f6e0d`) | e2e for folder bookmarks, pane search, sort |
| partial | M | Canvas (`HELP-bb4781a4c7d5`) | implement inline note editing + PDF preview with e2e |
| partial | M | Command palette (`HELP-cef11dca6f64`) | e2e for palette settings (pinned/recent) and ordering |
| partial | L | Core plugins (`HELP-9dd80d32dbd0`) | implement missing core plugins; e2e list parity |
| partial | S | Daily notes (`HELP-f2d70e909a99`) | e2e for ribbon + date-property link |
| partial | M | File explorer (`HELP-0d0984a3b9a6`) | e2e for create/rename/delete/sort menu |
| partial | S | Format converter (`HELP-d5b5268c30ff`) | confirm UID rule from Help page; add edge-case e2e |
| partial | L | Graph view (`HELP-b7bcdb79c9d3`) | implement filters/groups/forces/local graph + e2e |
| partial | M | Note composer (`HELP-a4da9ebb4208`) | implement heading extraction + property merge |
| partial | S | Outline (`HELP-90e23f298486`) | e2e for navigation and collapse |
| partial | S | Page preview (`HELP-503fd860c440`) | e2e for settings toggles and other surfaces |
| partial | M | Quick switcher (`HELP-b876a11dc698`) | e2e for open modes, create, aliases |
| partial | S | Random note (`HELP-c58257f77a68`) | unit/e2e for command, settings, note-only selection |
| partial | L | Search (`HELP-deed3cc349a3`) | e2e for search pane + remaining operators |
| partial | S | Slash commands (`HELP-229876d87d7b`) | assert arrow/Esc in e2e |
| partial | S | Slides (`HELP-37f3d8a96fc8`) | e2e for no-separator note and fullscreen details |
| partial | M | Tags view (`HELP-18e8ec0345df`) | e2e for tag list, nesting, sort |
| partial | S | Templates (`HELP-32c81f8a0b33`) | e2e for ribbon + property merge |
| partial | S | Unique note creator (`HELP-63abe8319cd5`) | match icon and error link |
| partial | M | Web viewer (`HELP-140b011d4105`) | e2e for save-to-vault and remaining settings |
| partial | S | Word count (`HELP-a4302b7f3f48`) | unit/e2e for counts incl. selection |

### User interface

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | L | Language settings (`HELP-69ff11f6c552`) | implement i18n + language setting + e2e |
| missing | L | Pop-out windows (`HELP-afc455bc1127`) | implement pop-out windows + e2e |
| partial | M | Appearance (`HELP-488454b5ae14`) | e2e/impl remaining Appearance options |
| partial | M | Drag and drop (`HELP-d672352c6196`) | e2e for remaining drag sources/targets |
| partial | M | More options menu (`HELP-f31eaed77863`) | e2e per menu item |
| partial | S | Ribbon (`HELP-fac893a1ddb7`) | e2e reorder + per-action hide |
| partial | M | Settings (`HELP-c23cb838430b`) | e2e for settings structure and entry points |
| partial | M | Sidebar (`HELP-2275277f7c92`) | e2e sidebar pin + toggle commands |
| partial | S | Status bar (`HELP-a6ba83b499a0`) | e2e status bar items |
| partial | M | Tabs (`HELP-12191d1676ab`) | e2e shortcuts, linked views |
| partial | M | Workspace (`HELP-1737f4ce3a15`) | e2e remaining layout features |

## Full gap list — changelog deltas 1.13.2–1.13.4 (missing / partial)

### Desktop 1.13.2

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | L | Added file-level context menu items to the Sync view. (`CHANGE-65351d44d7e3`) | implement a Sync file-list view + e2e; or document as out-of-scope |
| missing | M | Bookmarks: Fixed keyboard navigation in the Bookmarks view sometimes getting stuck due to missing bookmarked f (`CHANGE-cfbdab85bb1e`) | implement Bookmarks keyboard nav (skipping missing files) + e2e |
| missing | S | Editor: Fixed regression where "Toggle bold" would not remove the bold () markers when the cursor was inside b (`CHANGE-f1bf3680336b`) | implement toggle-off + unit/e2e |
| missing | M | File Explorer: Added support for dragging links from a Base into the File Explorer to move the file to a new l (`CHANGE-0f61076b086a`) | Base link dragstart + explorer drop + e2e |
| missing | M | Fixed how SettingGroup renders when used outside of a SettingTab. (`CHANGE-49b44e230a3f`) | implement SettingGroup API + unit test |
| missing | S | Fixed the "Copy" button not appearing on very large code blocks. (`CHANGE-2cc98daf3897`) | implement code-block copy button + e2e |
| missing | L | Live Preview: Added keyboard interactions when an image is selected. Press + or - to resize the selected image (`CHANGE-7d773bb28540`) | implement LP image selection keys (+/-/0/Enter/Tab) + e2e |
| missing | M | Live Preview: Clicking outside a selected image now deselects it. (`CHANGE-505fc16bc721`) | implement image selection/deselect + e2e |
| missing | L | New image lightbox for viewing images fullscreen. Click the image in reading mode to open it. Or in live previ (`CHANGE-d52aaeb9ffa3`) | implement lightbox + e2e |
| missing | M | Properties: Fixed an error when rendering []() inside a list property. (`CHANGE-d196a470fd7e`) | implement property link rendering + test |
| missing | S | Reading mode now supports external images with an image size and no alt text (e.g. !200). (`CHANGE-c031d15ffdda`) | size parse for ![N](url) in reading render + unit test |
| missing | M | Settings: Fixed page preview settings not saving. (`CHANGE-92fb0993e406`) | implement settings + persistence e2e |
| missing | S | Settings: Fixed pinned commands not showing commands from community plugins. (`CHANGE-0791ad4453e3`) | implement pinned commands incl. plugin commands + e2e |
| missing | M | Sync: Fixed a bug where clicking the status bar icon would not always open the menu. (`CHANGE-1a2ec804d7f0`) | implement status-bar sync menu + e2e |
| missing | L | The Sync view now supports deleting files with the Delete or Backspace key. (`CHANGE-cb53b6a2f818`) | implement a Sync file-list view + e2e; or document as out-of-scope |
| missing | L | The Sync view now supports multi-selection with the keyboard (Shift-arrow keys) or the mouse (Alt-click). (`CHANGE-c7ba0a163f96`) | implement a Sync file-list view + e2e; or document as out-of-scope |
| missing | L | Vim: A white "ghost" character no longer appears when the Vim cursor overlaps with a widget in the editor. (`CHANGE-1603ded9b652`) | implement Vim mode first |
| missing | L | Vim: Added a new :image Ex command to interact with the selected image. Use :image grow and :image shrink to r (`CHANGE-e794b2d10950`) | implement Vim mode + :image Ex command + e2e |
| partial | S | Bases: "File links" no longer show the image size as the image display name. (`CHANGE-869679621cfb`) | unit test: image link with size shows file name |

### Desktop 1.13.3

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | M | Added a "zoom" button to image embeds. (`CHANGE-23d9514a3a65`) | implement zoom button + e2e |
| missing | L | File Recovery: Added keyboard navigation to the file history records. Use arrow keys to navigate through the l (`CHANGE-64af4e3b08dd`) | implement File Recovery view + keyboard nav + e2e |
| missing | M | Fixed image resizing when an image is inside a Markdown table. (`CHANGE-51604152f7dc`) | implement/test LP resize in tables |
| missing | M | Fixed unique URI action not opening the new note in the correct tab when the paneType option is provided. (`CHANGE-b0c2a82af7e6`) | implement unique URI action with paneType + e2e |
| missing | M | Live Preview: Added a new selection state to image embeds. (`CHANGE-93bd0a1d0bf8`) | implement selection state + e2e |
| missing | M | The image lightbox now supports click and drag to pan within an image. (`CHANGE-bf0107c02d96`) | implement lightbox pan + e2e |
| missing | S | Unique Note Creator plugin now links to its own settings when it fails to find a template. (`CHANGE-5998129ff3b1`) | add settings link to failure notice + e2e |

### Desktop 1.13.4

| status | size | row | what a closing PR needs |
|---|---|---|---|
| missing | S | Improved layout of Page Preview settings. (`CHANGE-91c2110654dc`) | after settings exist: layout + e2e |
| missing | S | Live Preview: Fixed appearance of non-image embed actions. (`CHANGE-673449ba6c22`) | implement embed actions + e2e |
| missing | S | Settings: Download counts are now abbreviated for plugins and themes. (`CHANGE-d5faaa6cd0f7`) | show+abbreviate counts if source available; unit test |
| missing | M | Settings: Fixed Page Preview settings not showing entries from community plugins. (`CHANGE-a18c9005c0c1`) | plugin entries in Page Preview settings |
| missing | S | The image lightbox now displays the file name of the current image. (`CHANGE-d9d9991c4a7e`) | lightbox filename + e2e |
| partial | S | Live Preview: Fixed image disappearing when editing a Markdown embed and scrolling. (`CHANGE-949079634bad`) | e2e: edit md embed, scroll, image persists |

## Probably already done but unverified (need only an e2e)

Rows left `unknown` because the behavior seems implemented but no test asserts it, or the page has
no testable behavior:

- `HELP-37b44b79930f` Editing shortcuts — Editor binds CodeMirror defaultKeymap, historyKeymap, searchKeymap, indentWithTab, but no test asserts any shortcut on the page (grepped tests for Bold toggle, delete line, shortcuts: none relevant). 
- `HELP-bae939ca629f` Find and replace — markdown-view binds CodeMirror searchKeymap (default find/replace panel) but no unit or e2e test covers find, replace, or replace all. Grepped tests for replaceAll/find and replace: no editor-level hi
- `HELP-70264e2bf266` Home — Help site landing page: an index of links to other help pages with no testable app behavior of its own; nothing to assess beyond those pages' rows.
- `HELP-5e29d38c62f3` Back up your Obsidian files — Documentation-only guidance (backup strategy, third-party tools); no app behavior to test or implement.
- `HELP-edde92e5d308` Download and install Obsidian — Installer/download instructions for external platforms; not testable app behavior. Geode packaging tests (release-signing-config) do not map to the page.
- `HELP-c765eb112564` Glossary — Glossary is reference text only; no testable behavior.
- `CHANGE-a8516f98caa9` Live Preview: Fixed inline formatting not expanding properly when math or images are inside. For exa — Implemented, untested: LP handles EmphasisMark reveal (live-preview.ts) and math widgets (math-live.ts), but no test puts math/image inside bold and moves the cursor. src searched.
- `CHANGE-9444de609070` Reading mode no longer interprets %%%% as a non-terminated comment. Comments are always fenced with  — Implemented, untested: render.ts strips with /%%[\s\S]*?%%/g so %%%% is an empty terminated comment; comments/model.ts ObsidianComment likewise. render-inline.test.ts and comments.test.ts only cover %
- `CHANGE-fa8b8e154a41` Live Preview: When the image is the only text on a line, the editor line height is no longer preserv — Implemented, untested: LP image widgets are inline-block, vertical-align middle (styles/app.css ~L2769) with no height-preserving rule; no test measures line height. live-preview-markdown-image.spec.t
- `CHANGE-55cd74faadd9` Live Preview: Improved alignment of images inline with text. — Implemented, untested: inline LP image widgets use vertical-align: middle (styles/app.css ~L2769, 2780); no test asserts inline alignment with text.
- `CHANGE-1a6d6d64f69f` Live Preview: Removed extra padding around images. — Implemented, untested: no padding rules on .cm-embed-widget img (styles/app.css ~L2769-2785); no test asserts absence of extra padding.
- `CHANGE-eaca7908f0f1` Live Preview: Fixed the editor line height being preserved when editing an image embed on an indente — Implemented, untested: no line-height preservation rule for image widgets (styles/app.css ~L2769); nothing tests an indented image-only line while editing.

Also strong `partial` candidates (a single e2e would likely promote them): Bookmarks, Daily notes,
Outline, Page preview, Random note, Slides, Templates, Word count, Slash commands, Ribbon,
Status bar, Create your first note, Views and editing mode, Aliases, Callouts, Format converter.

## Spec ambiguities and judgment calls

- **Sync scope.** `docs/spec/01-core-app.md` / `00-overview.md` call Sync out of scope while `02` and `04`
  document it. Geode ships its own hub sync (ADRs 0007, 0015, 0016, 0025, 0029). Account, E2EE,
  collaboration, version browsing and the Sync file-list view are scored `missing`/`partial`, not
  equivalent, because no ADR declares them intentionally replaced (ADR 0015 only defers E2EE and version browsing).
  Headless Sync and plans/regions are `intentionally-equivalent`.
- **Teams / Licenses / Contributing / Obsidian-about** are blocked as out-of-scope on the task's product
  decision; no spec says so explicitly.
- **Map view** needs Obsidian's separate Maps plugin; a plugin-hosted route may be the intended design.
- **Symbolic links.** Geode refuses vault symlinks (`SYMLINK_UNSUPPORTED`, asserted) but no ADR records this
  as intentional; scored `missing` pending an ADR.
- **Documentation-only pages** (Home, Glossary, Back up, Download and install) and release-note section
  headings have no testable behavior and the status vocabulary has no value for that. Pages stay `unknown`;
  the six release-note heading rows are `blocked` with "not a behavior".
- **"Implemented, untested"** rows whose only candidate evidence is `src/` or `styles/` are left `unknown`
  (not `partial`) so that every non-`unknown` row cites a test, spec or ADR.
- Several `missing` rows cite the nearest `docs/spec/` file because the spec has no section for the
  specific behavior; the absence evidence is the recorded grep in `notes`.
- Mobile app / Android / iOS rows are `partial` on `tests/mobile/mobile-renderer.spec.ts`, which was skimmed, not read in depth.

## NOT VERIFIED

- No e2e specs were executed; `partial` rows citing e2e files were judged by reading assertions.
- Full `npm test` (build + Playwright) was not run: the PR changes docs JSON and markdown only.
- Test files cited for `partial` rows by delegated reviewers were not each independently re-read by the lead.
- `npm run parity:check` was run with `--help-root/--developer-root/--api-root` pointing at fresh clones
  under `/tmp/parity-corpora` (upstream HEAD of 2026-10-15, depth-50), not `/private/tmp`. Corpus commit
  SHAs: obsidian-help 08ef563, obsidian-developer-docs c56c7e7, obsidian-api 9abd960.

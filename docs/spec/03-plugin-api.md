# 03 — Obsidian Plugin & Theme API Specification

Clean-room reference for building an API-compatible extension layer. Sources: https://docs.obsidian.md (developer docs), `obsidianmd/obsidian-api` (`obsidian.d.ts`), `obsidianmd/obsidian-releases` (distribution), `obsidianmd/obsidian-sample-plugin` and `obsidian-sample-theme` (templates). API surface as of mid-2026 (app ~1.13).

---

## 1. Plugin Anatomy

### 1.1 Folder layout

Plugins live inside the vault at `<vault>/.obsidian/plugins/<plugin-id>/`. The config dir name is configurable per vault (`Vault.configDir`, default `.obsidian`). A loadable plugin folder contains:

| File | Required | Purpose |
|---|---|---|
| `manifest.json` | yes | Metadata + compatibility gate |
| `main.js` | yes | Bundled CommonJS entry point (esbuild/rollup output; `obsidian`, `electron`, and CM6 packages are externals provided at runtime by the app) |
| `styles.css` | no | Auto-injected stylesheet while plugin is enabled |
| `data.json` | no | Settings persisted via `loadData()`/`saveData()` |

`main.js` is a CJS module whose default export is a class extending `Plugin`. The host `require('obsidian')` is provided by the app; plugins are bundled with everything else inlined.

Themes live at `<vault>/.obsidian/themes/<Theme Name>/` containing `manifest.json` + `theme.css`. CSS snippets (single user CSS files, toggled individually in settings) live at `<vault>/.obsidian/snippets/*.css`.

### 1.2 manifest.json

Common fields (plugins and themes):

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name. Rules: short, English/Basic Latin, no punctuation besides `-`, `+`, `()`, no emoji, must not contain "Obsidian", must not duplicate core feature names, unique across directory |
| `version` | string | yes | SemVer `x.y.z` only (no `v` prefix, no prerelease tags) |
| `minAppVersion` | string | yes | Minimum Obsidian app version required |
| `author` | string | yes | |
| `authorUrl` | string | no | |
| `fundingUrl` | string \| Record<string,string> | no | Single URL or `{ "label": "url", ... }` map |

Plugin-only fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Lowercase letters/hyphens only; cannot end with `plugin`; cannot contain `obsidian`; must equal the folder name and the directory entry id |
| `description` | string | yes | |
| `isDesktopOnly` | boolean | yes | `true` if the plugin uses Node.js/Electron APIs; blocks install on mobile |

Theme manifests add `minAppVersion`, and the theme folder name must match `name` exactly.

### 1.3 versions.json (repo root, plugins)

Maps plugin version → minimum app version, used as a fallback lookup when the user's app is older than the current `minAppVersion`:

```json
{
  "0.1.0": "1.0.0",
  "0.12.0": "1.1.0"
}
```

If the latest plugin requires a newer app, Obsidian walks `versions.json` to find the newest plugin release compatible with the user's app version and installs that GitHub release instead. Only needs updating when `minAppVersion` changes.

### 1.4 Lifecycle

```ts
import { Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload()   { /* register everything; runs on enable + app start */ }
  async onunload() { /* release resources; runs on disable */ }
}
```

- `onload()` — called every time the plugin is enabled (including app startup). All `register*` helpers called here are auto-cleaned on unload.
- `onunload()` — called on disable/uninstall. Anything registered via `Component.register*` is reversed automatically; manual resources must be released here.
- `onUserEnable()` — called only when the user explicitly enables the plugin (not on app start); good place for first-run UX.
- `onExternalSettingsChange()` — called when `data.json` changes on disk (e.g., sync); reload settings here.
- Long work at startup should be deferred via `app.workspace.onLayoutReady(cb)` — runs immediately if the layout is already ready, otherwise on the `layout-ready` boundary.

---

## 2. Core Class Hierarchy

```
Events ── Component ── Plugin
   │          └────── View ── ItemView ── FileView ── TextFileView ── EditableFileView ── MarkdownView
   ├── Vault
   ├── Workspace ── (WorkspaceItem tree: WorkspaceParent → WorkspaceSplit/WorkspaceTabs/
   │                 WorkspaceRoot/WorkspaceSidedock/WorkspaceMobileDrawer/WorkspaceFloating;
   │                 leaves: WorkspaceLeaf; WorkspaceWindow for popouts; WorkspaceRibbon)
   ├── MetadataCache
   └── WorkspaceItem / WorkspaceLeaf
TAbstractFile ── TFile / TFolder
```

### 2.1 Events (base event emitter)

```ts
class Events {
  on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef;
  off(name: string, callback: (...data: any[]) => any): void;
  offref(ref: EventRef): void;
  trigger(name: string, ...data: any[]): void;
  tryTrigger(evt: EventRef, args: any[]): void;
}
interface EventRef {} // opaque token
```

Subclasses (`Vault`, `Workspace`, `MetadataCache`, `Menu`) declare typed `on(...)` overloads. The `EventRef` returned must be handed to `Component.registerEvent()` for automatic cleanup.

### 2.2 Component

The resource-ownership primitive. Everything cleanable hangs off a component tree.

```ts
class Component {
  load(): void;            // load this + children
  onload(): void;          // override
  unload(): void;          // unload this + children, run register() callbacks
  onunload(): void;        // override
  addChild<T extends Component>(component: T): T;   // child unloads with parent
  removeChild<T extends Component>(component: T): T;
  register(cb: () => any): void;                    // arbitrary cleanup fn
  registerEvent(eventRef: EventRef): void;          // auto-offref on unload
  registerDomEvent(el: Window | Document | HTMLElement, type: string,
    callback: (ev: Event) => any, options?: boolean | AddEventListenerOptions): void;
  registerInterval(id: number): number;             // auto-clearInterval
}
```

### 2.3 Plugin

```ts
abstract class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  constructor(app: App, manifest: PluginManifest);

  // UI surfaces
  addRibbonIcon(icon: IconName, title: string,
    callback: (evt: MouseEvent) => any): HTMLElement;
  addStatusBarItem(): HTMLElement;                 // desktop only (no status bar on mobile)
  addCommand(command: Command): Command;
  removeCommand(commandId: string): void;          // id without plugin prefix
  addSettingTab(settingTab: PluginSettingTab): void;

  // Registration (all auto-unregistered on unload)
  registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => View): void;
  registerExtensions(extensions: string[], viewType: string): void; // claim file extensions
  registerHoverLinkSource(id: string, info: HoverLinkSource): void;
  registerMarkdownPostProcessor(postProcessor: MarkdownPostProcessor,
    sortOrder?: number): MarkdownPostProcessor;
  registerMarkdownCodeBlockProcessor(language: string,
    handler: (source: string, el: HTMLElement,
      ctx: MarkdownPostProcessorContext) => Promise<any> | void,
    sortOrder?: number): MarkdownPostProcessor;
  registerEditorExtension(extension: Extension): void;  // CM6 Extension
  registerObsidianProtocolHandler(action: string,
    handler: (params: ObsidianProtocolData) => any): void; // obsidian:// in Obsidian; geode:// in Geode
  registerEditorSuggest(editorSuggest: EditorSuggest<any>): void;

  // Persistence — <plugin dir>/data.json
  loadData(): Promise<any>;
  saveData(data: any): Promise<void>;

  // Lifecycle hooks
  onload(): Promise<void> | void;
  onunload(): void;
  onUserEnable(): void;
  onExternalSettingsChange(): void;
}

interface PluginManifest {
  id: string; name: string; version: string; minAppVersion: string;
  author: string; description: string;
  authorUrl?: string; fundingUrl?: string; isDesktopOnly?: boolean;
  dir?: string;   // path to plugin folder in vault
}
```

Newer additions (1.13+): `registerCliHandler(command, description, flags, handler)` and `registerBasesView(viewId, registration)` — low priority for a clone.

Command interface:

```ts
interface Command {
  id: string;            // auto-prefixed "<plugin-id>:" when registered
  name: string;          // shown as "<Plugin Name>: <name>" in palette
  icon?: IconName;
  mobileOnly?: boolean;
  repeatable?: boolean;
  // exactly one execution style:
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
    // checking===true → return whether command is available, do nothing
    // checking===false → perform action
  editorCallback?: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => any;
  editorCheckCallback?: (checking: boolean, editor: Editor,
    ctx: MarkdownView | MarkdownFileInfo) => boolean | void;
  hotkeys?: Hotkey[];    // discouraged for published plugins (conflicts)
}
interface Hotkey { modifiers: Modifier[]; key: string; }
type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt';
// 'Mod' = Cmd on macOS, Ctrl on Win/Linux
```

Geode validates at `Plugin.addCommand` that exactly one of `callback`,
`checkCallback`, `editorCallback`, or `editorCheckCallback` is defined. Invalid
zero-style and mixed-style registrations do not reach the command registry or
register cleanup. Editor commands are available only for the live/source
`MarkdownView` belonging to the current invocation source; reading mode and
non-Markdown leaves have no editor context. The context argument is that
`MarkdownView`. The editor argument is currently the view's real CM6
`EditorView`, not yet the CM5-shaped `Editor` abstraction documented in §2.10,
so ordinary plugins that call methods such as `getCursor` or `replaceRange`
still require the separate Editor-adapter parity work.

### 2.4 App

The root object, passed into every plugin and view. Also exposed as global `app` (deprecated for plugin use, but exists).

```ts
class App {
  keymap: Keymap;
  scope: Scope;            // global hotkey scope; Scope = pushable keymap layer
  workspace: Workspace;
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;
  lastEvent: UserEvent | null;   // most recent user-initiated input event
  isDarkMode(): boolean;
  loadLocalStorage(key: string): any | null;   // vault-scoped localStorage
  saveLocalStorage(key: string, data: unknown | null): void;
}
```

Undocumented-but-universally-used internals a compatible clone must consider: `app.plugins` (community plugin registry: `enabledPlugins`, `getPlugin(id)`), `app.internalPlugins`, `app.commands.executeCommandById(id)`, `app.setting.open()`. These are not in `obsidian.d.ts` but a large share of real plugins touch them.

### 2.5 Workspace and layout tree

The workspace is a tree of `WorkspaceItem`s. Containers (`WorkspaceSplit`, `WorkspaceTabs`) hold children; terminal nodes are `WorkspaceLeaf`s, each hosting exactly one `View`. Top-level regions: `rootSplit` (main area), `leftSplit`/`rightSplit` (sidedocks, or `WorkspaceMobileDrawer` on mobile), `leftRibbon`, plus popout `WorkspaceWindow`s (desktop).

```ts
class Workspace extends Events {
  rootSplit: WorkspaceRoot;
  leftSplit: WorkspaceSidedock | WorkspaceMobileDrawer;
  rightSplit: WorkspaceSidedock | WorkspaceMobileDrawer;
  leftRibbon: WorkspaceRibbon;
  containerEl: HTMLElement;
  layoutReady: boolean;
  activeLeaf: WorkspaceLeaf | null;            // deprecated — use getActiveViewOfType
  activeEditor: MarkdownFileInfo | null;       // current editor context, may be null
  requestSaveLayout: Debouncer<[], Promise<void>>;

  onLayoutReady(callback: () => any): void;    // immediate if already ready
  getLayout(): any;                            // serializable layout JSON
  changeLayout(workspace: any): Promise<void>;

  // Leaf acquisition
  getLeaf(newLeaf?: boolean | 'tab' | 'split' | 'window', direction?: SplitDirection): WorkspaceLeaf;
  getLeafById(id: string): WorkspaceLeaf | null;
  getLeavesOfType(viewType: string): WorkspaceLeaf[];
  getLeftLeaf(split: boolean): WorkspaceLeaf | null;
  getRightLeaf(split: boolean): WorkspaceLeaf | null;
  ensureSideLeaf(type: string, side: 'left' | 'right',
    options?: { active?: boolean; split?: boolean; reveal?: boolean; state?: any }): Promise<WorkspaceLeaf>;
  getMostRecentLeaf(root?: WorkspaceParent): WorkspaceLeaf | null;
  getUnpinnedLeaf(): WorkspaceLeaf;
  createLeafBySplit(leaf: WorkspaceLeaf, direction?: SplitDirection, before?: boolean): WorkspaceLeaf;
  createLeafInParent(parent: WorkspaceSplit, index: number): WorkspaceLeaf;
  duplicateLeaf(leaf: WorkspaceLeaf, leafType: PaneType, direction?: SplitDirection): Promise<WorkspaceLeaf>;
  splitActiveLeaf(direction?: SplitDirection): WorkspaceLeaf;  // deprecated

  // Active state
  getActiveFile(): TFile | null;
  getActiveViewOfType<T extends View>(type: Constructor<T>): T | null;
  setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean }): void;
  revealLeaf(leaf: WorkspaceLeaf): Promise<void>;   // expands collapsed sidebar
  detachLeavesOfType(viewType: string): void;

  // Iteration / misc
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => any): void;
  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => any): void;
  getGroupLeaves(group: string): WorkspaceLeaf[];
  getLastOpenFiles(): string[];                     // 10 most recent paths
  openLinkText(linktext: string, sourcePath: string,
    newLeaf?: PaneType | boolean, openViewState?: OpenViewState): Promise<void>;
  openPopoutLeaf(data?: WorkspaceWindowInitData): WorkspaceLeaf;  // desktop
  moveLeafToPopout(leaf: WorkspaceLeaf, data?: WorkspaceWindowInitData): WorkspaceWindow;
  updateOptions(): void;   // reconfigure all markdown views — flushes dynamic editor extensions
  handleLinkContextMenu(menu: Menu, linktext: string, sourcePath: string, leaf?: WorkspaceLeaf): void;
}
type PaneType = 'tab' | 'split' | 'window';
type SplitDirection = 'horizontal' | 'vertical';
```

```ts
class WorkspaceLeaf extends WorkspaceItem {
  view: View;
  openFile(file: TFile, openState?: OpenViewState): Promise<void>;
  open(view: View): Promise<View>;
  getViewState(): ViewState;                 // { type, state, active?, pinned?, group? }
  setViewState(viewState: ViewState, eState?: any): Promise<void>;
  getEphemeralState(): any; setEphemeralState(state: any): void;
  togglePinned(): void; setPinned(pinned: boolean): void;
  setGroupMember(other: WorkspaceLeaf): void; setGroup(group: string): void;
  detach(): void;
  getDisplayText(): string; getIcon(): IconName;
  onResize(): void;
  isDeferred: boolean;                        // lazy-loaded leaf (1.7+) — implemented, see note
  loadIfDeferred(): Promise<void>;            // implemented, see note
  on(name: 'pinned-change', cb: (pinned: boolean) => any): EventRef;
  on(name: 'group-change', cb: (group: string) => any): EventRef;
}
```

> **`isDeferred` / `loadIfDeferred` — deliberate divergence.** Both are
> implemented, but they mean something different here. In Obsidian a deferred
> leaf is *lazy but always loadable*: the view exists, it just hasn't been
> rendered. In Geode a deferred leaf means **the provider for this view type
> isn't currently loaded** — the plugin is disabled, quarantined, mid-update,
> suppressed by crash recovery, or slower to start than the onload budget. The
> leaf holds a placeholder that preserves the saved `type` and `state` and
> hydrates into the real view the moment the factory registers.
>
> Two consequences for plugin authors:
>
> - `loadIfDeferred()` resolves **silently** when no factory is registered. It
>   never throws (unlike `setViewState`), because an unavailable provider is a
>   normal state in Geode rather than an error. Do not treat a resolved promise
>   as proof the view is live — check `isDeferred` after awaiting.
> - A placeholder **impersonates** the persisted view type, so
>   `getLeavesOfType('my-view')` returns it and the usual
>   `if (getLeavesOfType(VIEW).length) return;` guard still finds the pane.
>   That means `getLeavesOfType(VIEW)[0].view as MyView` is unsafe: prefer an
>   `instanceof MyView` check (or `leaf.isDeferred`) before using the view.
>   Geode awaits hydration before firing `onLayoutReady`, so the common case is
>   safe, but a plugin that queries later — after its own reload, say — can
>   legitimately see a placeholder.
>
> Built-in view types (`file-explorer`, `search`, `backlinks`, `outline`,
> `tag-pane`, `bookmarks`) and the core `empty` / `markdown` / `canvas` /
> `graph` / `base` types are never deferred.

### 2.6 View hierarchy

```ts
abstract class View extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  icon: IconName;
  navigation: boolean;     // true = behaves like a file tab (history); false = fixed panel
  scope: Scope | null;     // keymap scope while focused
  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): IconName;
  getState(): Record<string, unknown>;
  setState(state: any, result: ViewStateResult): Promise<void>;
  getEphemeralState(): Record<string, unknown>;
  setEphemeralState(state: unknown): void;
  onOpen(): Promise<void>;     // protected — build DOM here
  onClose(): Promise<void>;    // protected — cleanup
  onResize(): void;
  onPaneMenu(menu: Menu, source: string): void;
}

abstract class ItemView extends View {
  contentEl: HTMLElement;      // build content here (inside containerEl chrome)
  addAction(icon: IconName, title: string, callback: (evt: MouseEvent) => any): HTMLElement;
}

abstract class FileView extends ItemView {
  file: TFile | null;
  allowNoFile: boolean;
  navigation: boolean;         // defaults true for file views
  onLoadFile(file: TFile): Promise<void>;
  onUnloadFile(file: TFile): Promise<void>;
  onRename(file: TFile): Promise<void>;
  canAcceptExtension(extension: string): boolean;
}

abstract class TextFileView extends EditableFileView {
  data: string;                            // in-memory file contents
  requestSave: () => void;                 // debounced (~2s) save
  abstract getViewData(): string;          // serialize editor → string
  abstract setViewData(data: string, clear: boolean): void; // string → editor; clear=true on file switch
  abstract clear(): void;
  save(clear?: boolean): Promise<void>;
}
// EditableFileView sits between FileView and TextFileView (no extra abstract members).

class MarkdownView extends TextFileView {
  editor: Editor;
  previewMode: MarkdownPreviewView;
  currentMode: MarkdownSubView;
  hoverPopover: HoverPopover | null;
  getMode(): MarkdownViewModeType;         // 'source' | 'preview'
  showSearch(replace?: boolean): void;
}
interface MarkdownFileInfo { app: App; editor?: Editor; file: TFile | null; hoverPopover: HoverPopover | null; }
```

Registering a custom view:

```ts
export const VIEW_TYPE_EXAMPLE = 'example-view';
this.registerView(VIEW_TYPE_EXAMPLE, (leaf) => new ExampleView(leaf));
```

Rules the host must enforce/document: the view factory may be called multiple times — plugins must never cache view instances; always resolve via `getLeavesOfType()` then `instanceof` check. Use `revealLeaf()` to surface sidebar leaves. Avoid `detachLeavesOfType` in `onunload` (user layout should survive plugin updates).

### 2.7 Vault, DataAdapter, TAbstractFile

```ts
class Vault extends Events {
  adapter: DataAdapter;
  configDir: string;                        // '.obsidian' typically
  getName(): string;

  // Lookup (all paths vault-relative, '/' separators, no leading slash)
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getFileByPath(path: string): TFile | null;
  getFolderByPath(path: string): TFolder | null;
  getRoot(): TFolder;
  getAllLoadedFiles(): TAbstractFile[];
  getAllFolders(includeRoot?: boolean): TFolder[];
  getFiles(): TFile[];
  getMarkdownFiles(): TFile[];

  // Create
  create(path: string, data: string, options?: DataWriteOptions): Promise<TFile>;
  createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<TFile>;
  createFolder(path: string): Promise<TFolder>;

  // Read
  read(file: TFile): Promise<string>;        // always from disk — use before write-back
  cachedRead(file: TFile): Promise<string>;  // from cache — use for display
  readBinary(file: TFile): Promise<ArrayBuffer>;
  getResourcePath(file: TFile): string;      // app:// URL usable in <img src> etc.

  // Write
  modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void>;
  modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  append(file: TFile, data: string, options?: DataWriteOptions): Promise<void>;
  process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
    // atomic read→transform→write; preferred over read+modify (avoids lost updates)
  copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T>;

  // Remove / move
  delete(file: TAbstractFile, force?: boolean): Promise<void>;   // permanent
  trash(file: TAbstractFile, system: boolean): Promise<void>;    // OS trash or .trash/
  rename(file: TAbstractFile, newPath: string): Promise<void>;   // does NOT update links — use FileManager.renameFile

  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any): void;

  // Events
  on(name: 'create', cb: (file: TAbstractFile) => any, ctx?: any): EventRef;
    // also fired once per existing file at vault load — gate with onLayoutReady
  on(name: 'modify', cb: (file: TAbstractFile) => any, ctx?: any): EventRef;
  on(name: 'delete', cb: (file: TAbstractFile) => any, ctx?: any): EventRef;
  on(name: 'rename', cb: (file: TAbstractFile, oldPath: string) => any, ctx?: any): EventRef;
}
interface DataWriteOptions { ctime?: number; mtime?: number; }
```

`DataAdapter` is the low-level FS abstraction beneath Vault (implementations: `FileSystemAdapter` on desktop/Node, Capacitor adapter on mobile). String-path based, no TFile objects, can reach inside `.obsidian/`:

> Geode note: `vault.adapter` must be a real `FileSystemAdapter` instance (not a shape-compatible object literal), because desktop plugins branch on `adapter instanceof FileSystemAdapter` to detect real Node FS access — e.g. obsidian-claude-threads uses that guard to derive a chat's working directory and falls back to the home directory when it fails.

```ts
interface DataAdapter {
  getName(): string;
  exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
  stat(normalizedPath: string): Promise<Stat | null>;     // { type:'file'|'folder', ctime, mtime, size }
  list(normalizedPath: string): Promise<ListedFiles>;     // { files: string[], folders: string[] }
  read(normalizedPath: string): Promise<string>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
  getResourcePath(normalizedPath: string): string;
  mkdir(normalizedPath: string): Promise<void>;
  trashSystem(normalizedPath: string): Promise<boolean>;
  trashLocal(normalizedPath: string): Promise<void>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
  remove(normalizedPath: string): Promise<void>;
  rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
  copy(normalizedPath: string, normalizedNewPath: string): Promise<void>;
}
```

File tree objects (identity-stable: same TFile instance for a path across its lifetime):

```ts
abstract class TAbstractFile {
  vault: Vault;
  path: string;      // full vault-relative path
  name: string;      // basename + extension
  parent: TFolder | null;
}
class TFile extends TAbstractFile {
  basename: string;  // name without extension
  extension: string; // 'md', 'png', ... (no dot)
  stat: FileStats;   // { ctime, mtime, size } (ms epoch)
}
class TFolder extends TAbstractFile {
  children: TAbstractFile[];
  isRoot(): boolean;
}
```

Discriminate with `instanceof TFile` / `instanceof TFolder`.

### 2.8 MetadataCache

Parsed-markdown index. Asynchronous: updated after vault writes; consume via events.

```ts
class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>>;
    // sourcePath -> { destPath: linkCount } — backlink/graph data source
  unresolvedLinks: Record<string, Record<string, number>>;
    // sourcePath -> { unresolvedLinkText: count }

  getFileCache(file: TFile): CachedMetadata | null;
  getCache(path: string): CachedMetadata | null;
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
    // wikilink resolution: shortest-path-when-unique semantics
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension?: boolean): string;

  on(name: 'changed', cb: (file: TFile, data: string, cache: CachedMetadata) => any, ctx?: any): EventRef;
  on(name: 'deleted', cb: (file: TFile, prevCache: CachedMetadata | null) => any, ctx?: any): EventRef;
  on(name: 'resolve', cb: (file: TFile) => any, ctx?: any): EventRef;     // per-file link resolution done
  on(name: 'resolved', cb: () => any, ctx?: any): EventRef;               // all files resolved
}

interface CachedMetadata {
  links?: LinkCache[];          // [[wikilinks]]: { link, original, displayText?, position }
  embeds?: EmbedCache[];        // ![[embeds]]
  tags?: TagCache[];            // body #tags: { tag, position }
  headings?: HeadingCache[];    // { heading, level, position }
  sections?: SectionCache[];    // top-level blocks: { type: 'paragraph'|'heading'|'code'|..., id?, position }
  listItems?: ListItemCache[];  // { parent, task?, id?, position }
  frontmatter?: FrontMatterCache;            // parsed YAML object (+ position)
  frontmatterPosition?: Pos;
  frontmatterLinks?: FrontmatterLinkCache[]; // links inside frontmatter values
  blocks?: Record<string, BlockCache>;       // ^block-ids
}
interface Pos { start: Loc; end: Loc; }
interface Loc { line: number; col: number; offset: number; }
```

### 2.9 FileManager

Preference-aware file operations (the layer plugins should prefer for user-visible operations):

```ts
class FileManager {
  getNewFileParent(sourcePath: string, newFilePath?: string): TFolder;
    // honors "default location for new notes"
  renameFile(file: TAbstractFile, newPath: string): Promise<void>;
    // updates all links per user prefs (vs Vault.rename which does not)
  trashFile(file: TAbstractFile): Promise<void>;
    // honors user trash preference (.trash/ vs OS trash)
  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string;
    // wikilink vs markdown-link per user prefs, relative-path style etc.
  processFrontMatter(file: TFile, fn: (frontmatter: any) => void,
    options?: DataWriteOptions): Promise<void>;
    // atomic frontmatter read-mutate-write; creates frontmatter block if absent
  getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string>;
    // honors attachment-folder pref, dedupes name, ensures dir exists
}
```

### 2.10 Editor (CodeMirror abstraction)

`Editor` wraps the active CM6 instance with a CM5-flavored line/ch API so plugin code is editor-engine agnostic. Obtained from `MarkdownView.editor` or editor command callbacks.

```ts
interface EditorPosition { line: number; ch: number; }
interface EditorRange { from: EditorPosition; to: EditorPosition; }
interface EditorSelection { anchor: EditorPosition; head: EditorPosition; }
interface EditorChange extends EditorRangeOrCaret { text: string; }
interface EditorTransaction {
  replaceSelection?: string;
  changes?: EditorChange[];
  selections?: EditorSelectionOrCaret[];
  selection?: EditorRangeOrCaret;
}

abstract class Editor {
  getValue(): string;                     setValue(content: string): void;
  getLine(line: number): string;          setLine(n: number, text: string): void;
  lineCount(): number;                    lastLine(): number;
  getSelection(): string;                 somethingSelected(): boolean;
  getRange(from: EditorPosition, to: EditorPosition): string;
  replaceSelection(replacement: string, origin?: string): void;
  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void;
  getCursor(side?: 'from' | 'to' | 'head' | 'anchor'): EditorPosition;
  setCursor(pos: EditorPosition | number, ch?: number): void;
  listSelections(): EditorSelection[];
  setSelection(anchor: EditorPosition, head?: EditorPosition): void;
  setSelections(ranges: EditorSelectionOrCaret[], main?: number): void;
  focus(): void; blur(): void; hasFocus(): boolean;
  getScrollInfo(): { top: number; left: number };
  scrollTo(x?: number | null, y?: number | null): void;
  scrollIntoView(range: EditorRange, center?: boolean): void;
  undo(): void; redo(): void;
  exec(command: EditorCommandName): void;  // 'goUp'|'goDown'|'goLeft'|'goRight'|'indentMore'|'indentLess'|'newlineAndIndent'|'swapLineUp'|'swapLineDown'|'deleteLine'|'toggleFold'|'foldAll'|'unfoldAll'
  transaction(tx: EditorTransaction, origin?: string): void;
  wordAt(pos: EditorPosition): EditorRange | null;
  posToOffset(pos: EditorPosition): number;
  offsetToPos(offset: number): EditorPosition;
  processLines<T>(read: (line: number, lineText: string) => T | null,
    write: (line: number, lineText: string, value: T | null) => EditorChange | void,
    ignoreEmpty?: boolean): void;
  refresh(): void;
}
```

The raw CM6 `EditorView` is reachable at `(editor as any).cm` (undocumented but ubiquitous; a clone should provide it).

---

## 3. UI Primitives

### 3.1 Modal / SuggestModal / FuzzySuggestModal

```ts
class Modal implements CloseableComponent {
  app: App;
  scope: Scope;                 // Esc-to-close etc.
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;       // build UI here
  shouldRestoreSelection: boolean;
  constructor(app: App);
  open(): void; close(): void;
  onOpen(): void; onClose(): void;   // override
  setTitle(title: string): this;
  setContent(content: string | DocumentFragment): this;
}

abstract class SuggestModal<T> extends Modal {
  limit: number;                                   // default 100
  emptyStateText: string;
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  setPlaceholder(placeholder: string): void;
  setInstructions(instructions: Instruction[]): void;  // { command, purpose }
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
  onNoSuggestion(): void;
}

abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;           // fuzzy search runs over this
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
  renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement): void;  // default highlights matches
  getSuggestions(query: string): FuzzyMatch<T>[];                // built-in fuzzy matcher
}
interface FuzzyMatch<T> { item: T; match: SearchResult; }  // SearchResult: { score, matches: [number,number][] }
```

Related: `AbstractInputSuggest<T>` (popover suggestions on arbitrary inputs) and `EditorSuggest<T>` (inline editor autocompletion: `onTrigger(cursor, editor, file): EditorSuggestTriggerInfo | null`, `getSuggestions(context)`, `renderSuggestion`, `selectSuggestion`).

### 3.2 Setting / PluginSettingTab

```ts
abstract class PluginSettingTab extends SettingTab {
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin);
  abstract display(): void;   // re-build settings UI; called each time tab opens
  hide(): void;
}

class Setting {
  settingEl: HTMLElement; nameEl: HTMLElement; descEl: HTMLElement; controlEl: HTMLElement;
  constructor(containerEl: HTMLElement);
  setName(name: string | DocumentFragment): this;
  setDesc(desc: string | DocumentFragment): this;
  setClass(cls: string): this;
  setTooltip(tooltip: string): this;
  setHeading(): this;
  setDisabled(disabled: boolean): this;
  // each add* receives a component-builder callback:
  addText(cb: (text: TextComponent) => any): this;
  addTextArea(cb: (text: TextAreaComponent) => any): this;
  addToggle(cb: (toggle: ToggleComponent) => any): this;
  addDropdown(cb: (dropdown: DropdownComponent) => any): this;
  addSlider(cb: (slider: SliderComponent) => any): this;
  addButton(cb: (button: ButtonComponent) => any): this;
  addExtraButton(cb: (button: ExtraButtonComponent) => any): this;
  addMomentFormat(cb: (format: MomentFormatComponent) => any): this;
  addSearch(cb: (search: SearchComponent) => any): this;
  addColorPicker(cb: (picker: ColorComponent) => any): this;
  then(cb: (setting: this) => any): this;
  clear(): this;
}
// Component builders share: setValue(v), getValue(), onChange(cb), setPlaceholder, setDisabled.
```

Canonical settings persistence pattern:

```ts
interface MySettings { mySetting: string; }
const DEFAULT_SETTINGS: MySettings = { mySetting: 'default' };

async loadSettings() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
}
async saveSettings() { await this.saveData(this.settings); }
```

Note: Obsidian 1.13 added a declarative settings system (`getSettingDefinitions()` returning typed control definitions with `key` binding, `visible`/`disabled` predicates, groups/lists/sub-pages, automatic persistence). The imperative `display()` + `Setting` builder remains the compatibility baseline.

### 3.3 Notice, Menu, icons

```ts
class Notice {
  constructor(message: string | DocumentFragment, duration?: number); // ms; 0 = persistent until dismissed
  noticeEl: HTMLElement;
  setMessage(message: string | DocumentFragment): this;
  hide(): void;
}

class Menu extends Component implements CloseableComponent {
  addItem(cb: (item: MenuItem) => any): this;
  addSeparator(): this;
  setNoIcon(): this;
  showAtMouseEvent(evt: MouseEvent): this;
  showAtPosition(position: MenuPositionDef, doc?: Document): this;
  hide(): this;
  close(): void;
  onHide(callback: () => any): void;
}
class MenuItem {
  setTitle(title: string | DocumentFragment): this;
  setIcon(icon: IconName | null): this;
  setChecked(checked: boolean | null): this;
  setDisabled(disabled: boolean): this;
  setIsLabel(isLabel: boolean): this;
  setSection(section: string): this;
  onClick(callback: (evt: MouseEvent | KeyboardEvent) => any): this;
}
```

Notices auto-dismiss after their duration and can also be dismissed by clicking the notice or its accessible close button. Interactive descendants inside a `DocumentFragment` keep their normal click behavior.

Icons: built-in set is Lucide; helpers `setIcon(el, iconId)`, `addIcon(iconId, svgContent)`, `getIconIds()`. Ribbon: `addRibbonIcon(icon, title, cb)` adds to left ribbon (user can remove/reorder; mobile exposes via menu). Status bar: `addStatusBarItem(): HTMLElement` (desktop only); returned element accepts children/classes (`setText` helper works on it).

---

## 4. Events Catalog

All events return `EventRef`; plugins wrap with `this.registerEvent(...)`.

| Emitter | Event | Callback | Notes |
|---|---|---|---|
| Vault | `create` | `(file: TAbstractFile)` | Also fires per existing file during initial vault load |
| Vault | `modify` | `(file: TAbstractFile)` | Any write, internal or external |
| Vault | `delete` | `(file: TAbstractFile)` | |
| Vault | `rename` | `(file: TAbstractFile, oldPath: string)` | Move = rename |
| MetadataCache | `changed` | `(file, data, cache)` | File re-indexed, cache fresh |
| MetadataCache | `deleted` | `(file, prevCache \| null)` | |
| MetadataCache | `resolve` | `(file)` | Per-file link resolution |
| MetadataCache | `resolved` | `()` | Full-vault resolution complete |
| Workspace | `active-leaf-change` | `(leaf: WorkspaceLeaf \| null)` | |
| Workspace | `file-open` | `(file: TFile \| null)` | Active file changed |
| Workspace | `layout-change` | `()` | |
| Workspace | `quick-preview` | `(file: TFile, data: string)` | Active md file modified (pre-save) |
| Workspace | `resize` | `()` | |
| Workspace | `css-change` | `()` | Theme/snippet/style change |
| Workspace | `file-menu` | `(menu: Menu, file: TAbstractFile, source: string, leaf?: WorkspaceLeaf)` | Add items to file context menu |
| Workspace | `files-menu` | `(menu, files: TAbstractFile[], source, leaf?)` | Multi-select |
| Workspace | `url-menu` | `(menu, url: string)` | |
| Workspace | `editor-menu` | `(menu, editor: Editor, info: MarkdownView \| MarkdownFileInfo)` | |
| Workspace | `editor-change` | `(editor, info)` | After edits applied |
| Workspace | `editor-paste` | `(evt: ClipboardEvent, editor, info)` | Preventable |
| Workspace | `editor-drop` | `(evt: DragEvent, editor, info)` | Preventable |
| Workspace | `window-open` / `window-close` | `(win: WorkspaceWindow, window: Window)` | Popouts |
| Workspace | `quit` | `(tasks: Tasks)` | App closing |
| WorkspaceLeaf | `pinned-change`, `group-change` | | |

---

## 5. Editor Extensions (CodeMirror 6)

Obsidian's Live Preview editor is stock CodeMirror 6; "an Obsidian editor extension is the same thing as a CodeMirror 6 extension." `@codemirror/state`, `@codemirror/view`, `@codemirror/language` etc. must be treated as externals — the app supplies the single shared instance (duplicate CM6 copies break `instanceof`/facets).

- **Register:** `this.registerEditorExtension(extension)` in `onload()`, where `extension: Extension` (single, array, or nested). Applied to every editor instance, including popouts. To change extensions dynamically, keep a mutable array you registered once, swap its contents, then call `app.workspace.updateOptions()`.
- **View plugins** (`ViewPlugin.fromClass(class implements PluginValue { constructor(view: EditorView); update(u: ViewUpdate); destroy(); }, spec?)`): run after viewport recomputation; cheap, viewport-scoped; may NOT make changes that affect layout/viewport (no inserting blocks/line breaks). Provide decorations via the spec `{ decorations: v => v.decorations }`.
- **State fields** (`StateField.define<T>({ create(state), update(value, tr), provide? })` + `StateEffect.define<V>()`): pure document/state-scoped; required when decorations can change layout (block widgets, replacing line breaks); updated via `view.dispatch({ effects: [...] })` transactions.
- **Decorations:** `Decoration.mark` (style ranges), `Decoration.widget` (insert `WidgetType` with `toDOM()`), `Decoration.replace` (hide/replace ranges), `Decoration.line` (line classes). Built with `RangeSetBuilder<Decoration>` into a `DecorationSet`, typically walking `syntaxTree(view.state)` over `view.visibleRanges`.
- Obsidian-specific CM facets exported from `obsidian`: `editorInfoField` (StateField giving the owning `MarkdownFileInfo`/file), `editorLivePreviewField` (boolean: Live Preview vs Source mode), `editorEditorField` (the EditorView), `livePreviewState`.
- Reading view is NOT CodeMirror — use markdown post processors there.

---

## 6. Markdown Post-Processing (Reading view)

Reading view renders markdown → HTML, then runs registered post processors over the resulting elements (per rendered section/block, not whole document).

```ts
type MarkdownPostProcessor = (el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void;
// plus optional .sortOrder on the function — lower runs earlier

interface MarkdownPostProcessorContext {
  docId: string;
  sourcePath: string;
  frontmatter: any | null | undefined;
  getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
    // { text (full source), lineStart, lineEnd }
  addChild(child: MarkdownRenderChild): void;
    // tie a Component to the rendered element's lifecycle
}
```

- `registerMarkdownPostProcessor(processor, sortOrder?)` — mutate rendered HTML (e.g., transform `<code>` runs, decorate links).
- `registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {...}, sortOrder?)` — owns fenced blocks ` ```language ` entirely: receives raw block `source`, renders into `el` (the placeholder element). One processor per language app-wide; collision = registration error.
- `MarkdownRenderChild extends Component` — constructor takes `containerEl`; unloaded automatically when that element leaves the DOM. Use for processors with timers/subscriptions.
- `MarkdownRenderer.render(app, markdown, el, sourcePath, component)` — render arbitrary markdown into an element (used by plugins to nest rendering inside custom views/code blocks).

---

## 7. HTML Element Helpers

Obsidian augments `Node`/`Element`/`HTMLElement` prototypes globally (a clone must replicate these — virtually every plugin uses them):

```ts
interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: { [key: string]: string | number | boolean | null };
  title?: string;
  parent?: Node;
  value?: string;       // for inputs
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;        // for <a>/<link>/<base>
}

// On Node/Element prototypes:
createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: DomElementInfo | string,
  callback?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
createDiv(o?: DomElementInfo | string, callback?): HTMLDivElement;
createSpan(o?: DomElementInfo | string, callback?): HTMLSpanElement;
createSvg(tag, o?): SVGElement;
empty(): void;                       // remove all children
detach(): void;                      // remove self
setText(val: string | DocumentFragment): void;
appendText(val: string): void;
addClass(...classes); removeClass(...classes);
toggleClass(classes: string | string[], value: boolean): void;
setAttr(qualifiedName, value); getAttr(qualifiedName);
show(); hide(); toggle(show: boolean);
onClickEvent(listener, options?);
on(selector: string, event: string, listener, options?);   // delegated
find(selector): HTMLElement; findAll(selector): HTMLElement[]; findAllSelf(selector);
// Globals: createEl/createDiv/createSpan/createFragment also exist as free functions
//          (attach to activeDocument for popout-window correctness).
```

Other exported utilities a compatible layer should provide: `normalizePath(path)`, `debounce(fn, timeout, resetTimer)`, `setTooltip(el, tooltip, options)`, `sanitizeHTMLToDom(html)`, `getAllTags(cache)`, `parseFrontMatterEntry/Aliases/Tags(frontmatter, key)`, `parseYaml`/`stringifyYaml`, `parseLinktext(linktext)`, `getLinkpath(linktext)`, `htmlToMarkdown(html)`, `prepareFuzzySearch(query)`, `prepareSimpleSearch(query)`, `renderMath`/`loadMathJax`, `loadPrism`, `loadMermaid`, `moment` (bundled), `apiVersion`.

---

## 8. Network: requestUrl

```ts
function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise;

interface RequestUrlParam {
  url: string;
  method?: string;             // default GET
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;             // default true: reject on status >= 400
}
interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}
// RequestUrlResponsePromise = Promise<RequestUrlResponse> & { json, text, arrayBuffer } promise shortcuts
```

Key property: bypasses CORS entirely (routed through the privileged process on desktop / native layer on mobile). This is the sanctioned way for plugins to call arbitrary HTTP APIs; a clone needs an equivalent privileged proxy.

---

## 9. obsidian:// URI Protocol

Geode registers the equivalent `geode://<action>?param=value` OS protocol and dispatches it through the same `registerObsidianProtocolHandler` plugin API. Plugins can explicitly detect Geode through `window.geode.host`, whose stable value is `{ name: "geode", protocolScheme: "geode" }`.

App registers the `obsidian://` OS-level scheme. Form: `obsidian://<action>?param=value&...` (values strictly URI-encoded; `/`→`%2F`, space→`%20`). Built-in actions:

| Action | Parameters |
|---|---|
| `open` | `vault` (name or ID), `file` (vault-relative, .md implied), `path` (absolute path alternative), `paneType` (`tab`/`split`/`window`) — also accepts heading/block subpaths in `file` |
| `new` | `vault`, `name`/`file`/`path`, `content` or `clipboard`, `silent` (don't open), `append`, `overwrite`, `paneType`, `x-success` |
| `daily` | same as `new`, targets today's daily note (Daily notes plugin) |
| `unique` | `vault`, `content`/`clipboard`, `paneType`, `x-success` (Unique note creator plugin) |
| `search` | `vault`, `query` |
| `choose-vault` | none — opens vault switcher |
| `hook-get-address` | `vault`, `x-success`, `x-error` (x-callback-url for the Hook app) |

`Plugin.registerObsidianProtocolHandler(action, handler)` adds custom actions; handler receives `ObsidianProtocolData` = parsed query params plus `action`. Shortened form `obsidian://vault/<vaultname>/<filepath>` is equivalent to `open`.

---

## 10. Themes & CSS System

### 10.1 Theme mechanics

- A theme = `manifest.json` + a single `theme.css` installed at `.obsidian/themes/<Name>/`. Exactly one community theme active at a time; it loads after the app's `app.css` so its rules/variable overrides win by source order.
- CSS snippets (`.obsidian/snippets/*.css`) load after the theme — user-level final overrides, individually toggleable.
- No JS in themes. Everything is driven by CSS custom properties (“more than 400 CSS variables”).

### 10.2 Cascade & body classes

The `<body>` element carries mode/state classes the entire variable system keys off:

- `.theme-dark` / `.theme-light` — color scheme. App defines color variables separately under `.theme-dark {...}` and `.theme-light {...}`; themes override the same way:

```css
body { --font-text-theme: Georgia, serif; }        /* scheme-independent */
.theme-dark  { --background-primary: #18004F; }
.theme-light { --background-primary: #ECE4FF; }
:root { --input-hover-border-color: red; }          /* global/plugin variables */
```

- Platform/feature classes plugins+themes rely on: `.is-mobile`, `.is-phone`, `.is-tablet`, `.is-ios`, `.is-android`, `.is-frameless`/`.is-hidden-frameless`, `.is-focused`, `.is-translucent`, plus user-toggle classes like `.show-inline-title`, `.readable-line-length`. Workspace emits `css-change` when any of this changes.
- Accent color: user-picked HSL exposed as `--accent-h`, `--accent-s`, `--accent-l`; derived `--interactive-accent`, `--text-accent`, etc.

### 10.3 Variable taxonomy (organization of the ~400 vars)

1. **Foundations** — borders, colors (`--color-base-00`…`--color-base-100` ramp; semantic `--background-primary`, `--background-secondary`, `--background-modifier-border`, `--text-normal`, `--text-muted`, `--text-faint`, `--text-accent`, `--text-on-accent`, `--text-error`; color swatches `--color-red`/`--color-red-rgb` etc.), cursor, icons (`--icon-size`, `--icon-color`), layers (z-index: `--layer-modal`, `--layer-popover`, …), radiuses (`--radius-s/m/l/xl`), spacing (`--size-2-1`…`--size-4-18` scale), typography (`--font-text`, `--font-interface`, `--font-monospace`, `--font-ui-small`, `--font-text-size`, weights, line heights; theme injection points `--font-text-theme`, `--font-interface-theme`, `--font-monospace-theme`).
2. **Components** — button, checkbox, color input, dialog, dragging, indentation guides, modal, multi-select, navigation (`--nav-item-*`), popover, prompt, slider, tabs (`--tab-*`), text input, toggle.
3. **Editor** — block, blockquote, callout (`--callout-<type>-color`…), checklist, code (`--code-background`, `--code-normal`, syntax `--code-keyword`…), embed, file, footnote, headings (`--h1-size`…`--h6-*`, `--inline-title-*`), horizontal rule, indentation, inline title, links (`--link-color`, `--link-external-color`), lists, properties, table (`--table-*`), tag (`--tag-*`).
4. **Plugins (core)** — canvas (`--canvas-*`), file explorer (`--vault-name-*`), graph (`--graph-node`, `--graph-line`…), search (`--search-result-*`), sync.
5. **Window** — divider, ribbon (`--ribbon-*`), scrollbar (`--scrollbar-*`), status bar (`--status-bar-*`), titlebar (`--titlebar-*`), workspace (`--workspace-background-translucent`…).

A clone must replicate the variable names + body-class cascade for theme compatibility; the variable reference is the contract, the concrete default values are implementation detail.

---

## 11. Community Distribution

### 11.1 Registries

`obsidianmd/obsidian-releases` repo hosts the directory files the app consumes:

- `community-plugins.json` — array of `{ "id", "name", "author", "description", "repo" }` (repo = `user/name` on GitHub). `name`/`author`/`description` power in-app search. Stats in `community-plugin-stats.json`; removals/blocklist in `community-plugins-removed.json`.
- `community-css-themes.json` — array of `{ "name", "author", "repo", "screenshot", "modes": ["dark","light"], "legacy"? }`.

### 11.2 Submission flow (current)

1. Repo must contain `README.md`, `LICENSE`, `manifest.json` at root (manifest read from HEAD of default branch).
2. Create a GitHub **release** whose **tag exactly equals `manifest.json` `version`** (no `v` prefix), attaching as release assets: `main.js` (required), `manifest.json` (required), `styles.css` (optional). Themes attach `manifest.json` + `theme.css`; repo also needs a screenshot (~512×288).
3. Submit at `community.obsidian.md` → sign in with Obsidian account → link GitHub → Plugins → New plugin → repo URL → agree to developer policies. (Historically this was a PR adding an entry to `community-plugins.json`; the portal now automates it.) Automated review bot reports issues; fix by pushing a new release with bumped version.
4. After approval, **updates need no resubmission**: the app reads `manifest.json` at repo HEAD for the latest version, consults `versions.json` if `minAppVersion` exceeds the user's app, then downloads the release assets from the tag matching the chosen version into `.obsidian/plugins/<id>/` (or `.obsidian/themes/<name>/`).

### 11.3 In-app install algorithm (what a clone must implement)

1. Fetch registry JSON; search over name/author/description.
2. On install: fetch `https://github.com/<repo>` → raw `manifest.json` (default branch) → pick version (current, or `versions.json` fallback for old app) → GET release by tag → download asset files → write into config dir → enable on user toggle.
3. Update check: compare installed `manifest.json` version vs repo HEAD manifest version.

Release automation reference: `Release your plugin with GitHub Actions` (tag push → action builds and attaches `main.js`/`manifest.json`/`styles.css` as a draft release).

---

## 12. Mobile Considerations

- Mobile app = same JS app inside Capacitor (no Node, no Electron). Any `require('fs')`/`electron` call crashes the plugin → `isDesktopOnly: true` in manifest gates install.
- `Platform` (constant object, below) for runtime branching; `app.isMobile` also exists. Desktop devtools can simulate via `this.app.emulateMobile(true)`.
- API gaps on mobile: `FileSystemAdapter` (desktop class) absent; popout windows unavailable; status bar hidden; regex lookbehind requires iOS 16.4+ (provide fallbacks).
- Debugging: Android via `chrome://inspect`, iOS via Safari Web Inspector (macOS required).

```ts
const Platform: {
  isDesktop: boolean; isMobile: boolean;          // UI mode
  isDesktopApp: boolean; isMobileApp: boolean;    // packaging
  isIosApp: boolean; isAndroidApp: boolean;
  isPhone: boolean; isTablet: boolean;
  isMacOS: boolean; isWin: boolean; isLinux: boolean; isSafari: boolean;
  resourcePathPrefix: string;                      // prefix for app:// resource URLs
};
```

---

## 13. Implementation Notes for the Clone

1. **Module provision:** plugin `main.js` is CJS; host must provide `require('obsidian')` (the full export surface above), `require('@codemirror/*')`/`@lezer/*` (single shared instances), and on desktop `electron` + Node builtins.
2. **Load order:** app core → vault index → enabled plugins' `onload()` (manifest `minAppVersion` gate first) → `layout-ready`. Vault `create` events replay for existing files before layout-ready.
3. **Cleanup contract:** everything funnels through `Component.unload()`; getting this tree right gives plugin enable/disable hot-swap for free.
4. **Identity stability:** TFile/TFolder instances must be stable per path; MetadataCache must be eventually consistent with explicit `changed`/`resolved` events.
5. **Prototype augmentation** of DOM (createEl family) is load-bearing across the entire ecosystem — implement early.
6. **Undocumented internals** (`app.plugins`, `app.commands`, `editor.cm`, `app.setting`) are de-facto API; popular plugins (Dataview, Templater, etc.) break without them. Decide compatibility scope explicitly.
7. **Settings persistence** is per-plugin `data.json` with no schema; sync engines must fire `onExternalSettingsChange`.
8. **CSS variable contract** is the entire theme API; ship the documented variable set + body classes verbatim.

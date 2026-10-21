import { setIcon } from "./api/icons";
import { VaultAccessError } from "./host/contracts";
import { mobileVaultActions, vaultAccessPresentation } from "./host/mobile-vault-access";
import { LAUNCH_PANEL_HTML, SKIP_BUTTON_HTML, renderLaunchPanel } from "./launch/launch-overlay";
import type { LaunchRunner } from "./launch/launch-sequence";
import {
  nextHubCardIndex,
  vaultAvatarColor,
  vaultInitial,
  vaultNameFromPath,
  type HubNavKey,
} from "./vault-hub-model";

/**
 * The Vault Hub: one full-window screen that is both the first-run vault picker
 * and the "Manage vaults" surface, replacing the old modal. It reuses the
 * `.vault-picker` surface and lockup of the launch screen, and choosing a card
 * morphs that card into the launch progress panel (see `beginMorph`).
 *
 * The hub owns presentation and focus only. Everything that touches a vault
 * (opening, switching, creating, the registry) is injected through
 * `VaultHubOptions`, so launch logic is not duplicated here.
 */

export type VaultHubMode = "first-run" | "switcher";

/**
 * What the hub should do once `openVault` resolves.
 * - `dismiss`: the vault is open (or the new window exists): fade the hub out.
 * - `wait`: leave the morphed card up; something else ends it (a page reload for an
 *   in-window switch, or `completeLaunch()` for a first-run open).
 */
export type VaultHubOutcome = "dismiss" | "wait";

export interface VaultHubEntry {
  path: string;
  name: string;
  /** Second line of the card: the folder path, or "On this device" / "Files folder" on iOS. */
  detail: string;
}

/** Where a `.vault` pack for "Create vault from pack…" comes from. */
export type VaultHubPackSource =
  | { kind: "pick" }
  | { kind: "path"; path: string }
  | { kind: "dropped"; file: File };

export interface VaultHubPackOptions {
  /** Resolve + inspect the pack and show the consent screen inside `host`; resolves once it is on screen. Rejects with a readable error. */
  show(host: HTMLElement, opener: HTMLElement, source: VaultHubPackSource, onCreated: (path: string) => Promise<void>): Promise<void>;
  /** Packs in the machine-level organization directory (manifest-only listing). */
  listOrganization(): Promise<Array<{ path: string; fileName: string; name?: string; version?: string; error?: string }>>;
}

export interface VaultHubOptions {
  mode: VaultHubMode;
  brandChipHtml: string;
  /** The vault open in this window, if any. */
  currentPath: string | null;
  entries: VaultHubEntry[];
  /** Resolves the final name/detail for a card whose descriptor is only known asynchronously (iOS). */
  describe?: (path: string) => Promise<{ name: string; detail: string }>;
  ios: boolean;
  /** Wording and availability follow host capabilities; see App.openVaultHub. */
  externalVaultFolder: boolean;
  canOpenInNewWindow: boolean;
  openVault(path: string, options: { newWindow: boolean }): Promise<VaultHubOutcome>;
  chooseFolder(): Promise<string | null>;
  chooseExternalFolder(): Promise<string | null>;
  reconnect(vaultId: string): Promise<boolean>;
  /** Present only where the registry can forget a vault (desktop). */
  removeFromList?: (path: string) => Promise<void>;
  /** Present only where vaults can be created (desktop Electron). Mounts the existing create dialog inside `host`. */
  showCreateVault?: (host: HTMLElement, opener: HTMLElement, onCreated: (path: string) => Promise<void>) => void;
  /** Present only where vault packs are supported (desktop Electron; ADR 0050). */
  vaultPack?: VaultHubPackOptions;
  /** Present only on first run on desktop. */
  exploreSample?: () => Promise<{ path: string; onOpened?: () => Promise<void> } | null>;
  /**
   * Suspend the workspace's command hotkeys while the hub is up; returns the release. Optional so
   * the hub stays testable without an app. (A modal's Scope still reaches the root scope, so hotkeys
   * keep working over it; the hub is a full-window screen and must not run commands behind itself.)
   */
  captureKeys?: () => () => void;
  /** Called once the hub has fully gone away, so the owner can drop its reference. */
  onClosed?: () => void;
}

const FADE_OUT_MS = 220;
const SIBLING_FADE_MS = 180;
const MORPH_MS = 360;

interface MenuItem {
  label: string;
  icon: string;
  danger?: boolean;
  run: () => void;
}

export class VaultHub {
  readonly mode: VaultHubMode;
  private root!: HTMLElement;
  private grid!: HTMLElement;
  private errorEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private state: "browsing" | "opening" | "closed" = "browsing";
  private actionPending = false;
  private previousFocus: Element | null = null;
  private menuEl: HTMLElement | null = null;
  private menuOpener: HTMLElement | null = null;
  private selectedCard: HTMLElement | null = null;
  private selectedName = "";
  private transientCard: HTMLElement | null = null;
  private morphTimer: ReturnType<typeof setTimeout> | null = null;
  private unbindLaunch: (() => void) | null = null;
  private entries: VaultHubEntry[];
  private releaseKeys: (() => void) | null = null;

  constructor(private readonly opts: VaultHubOptions) {
    this.mode = opts.mode;
    this.entries = [...opts.entries];
  }

  get isOpening(): boolean {
    return this.state === "opening";
  }

  /** The hub's root element (consent screens for packs are mounted inside it). */
  get rootElement(): HTMLElement {
    return this.root;
  }

  /** A vault was created outside the hub's own cards (e.g. from a pack's consent screen): open it with the usual morph. */
  adoptCreated(path: string): Promise<void> {
    return this.runAction(() => this.launch(path, vaultNameFromPath(path)));
  }

  get isOpen(): boolean {
    return this.state !== "closed";
  }

  /** Mount over the whole window and move focus to the vault that is open here (or the first card). */
  open(): void {
    this.previousFocus = document.activeElement;
    const root = document.createElement("div");
    root.className = "vault-picker vault-hub";
    if (this.opts.mode === "first-run") root.classList.add("is-first-run");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Vaults");
    if (this.opts.mode === "switcher") root.setAttribute("aria-modal", "true");
    this.root = root;

    if (this.opts.mode === "switcher") {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "vault-hub-close";
      close.setAttribute("aria-label", "Close vault hub");
      close.title = "Close (Esc)";
      setIcon(close, "x");
      close.addEventListener("click", () => this.close());
      root.appendChild(close);
    }

    const content = document.createElement("div");
    content.className = "vault-hub-content";
    const lockup = document.createElement("div");
    lockup.className = "vault-picker-lockup";
    lockup.innerHTML = `${this.opts.brandChipHtml}<h1>Geode</h1>`;
    this.subtitleEl = document.createElement("p");
    this.subtitleEl.className = "vault-hub-subtitle";
    this.grid = document.createElement("div");
    this.grid.className = "vault-hub-grid";
    this.grid.setAttribute("role", "group");
    this.grid.setAttribute("aria-label", "Vaults");
    this.errorEl = document.createElement("div");
    this.errorEl.className = "vault-hub-error";
    this.errorEl.setAttribute("role", "alert");
    this.errorEl.hidden = true;
    content.append(lockup, this.subtitleEl, this.grid, this.errorEl);
    if (this.opts.vaultPack) this.mountPackSurfaces(content, root);
    if (this.opts.mode === "switcher") {
      const hint = document.createElement("p");
      hint.className = "vault-hub-hint";
      hint.textContent = "Arrow keys to move, Enter to open, Esc to close";
      content.appendChild(hint);
    }
    root.appendChild(content);

    this.renderCards();
    root.addEventListener("keydown", (event) => this.onKeydown(event));
    root.addEventListener("mousedown", (event) => {
      if (this.menuEl && !this.menuEl.contains(event.target as Node) && event.target !== this.menuOpener) this.closeMenu();
    });
    document.body.appendChild(root);
    this.releaseKeys = this.opts.captureKeys?.() ?? null;

    const focusTarget =
      root.querySelector<HTMLElement>(".vault-hub-card.is-current .vault-hub-card-main") ??
      root.querySelector<HTMLElement>(".vault-hub-card-main");
    focusTarget?.focus();

    const describe = this.opts.describe;
    if (describe) {
      for (const entry of this.entries) {
        void describe(entry.path).then(
          (described) => this.updateEntry(entry.path, described),
          (error) => {
            this.updateEntry(entry.path, { name: "Unavailable vault", detail: "Unavailable" });
            if (this.opts.mode === "switcher") this.showError(error);
          },
        );
      }
    }
  }

  /** Fade out and remove. Safe to call repeatedly. */
  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.cancelMorphTimer();
    this.unbindLaunchRunner();
    this.closeMenu();
    this.releaseKeys?.();
    this.releaseKeys = null;
    const root = this.root;
    root.classList.add("is-closing");
    setTimeout(() => {
      root.remove();
      this.opts.onClosed?.();
    }, FADE_OUT_MS + 30);
    const previous = this.previousFocus;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }

  /** The launch sequence for the vault this hub is opening has started: drive the morphed card from its snapshot. */
  bindLaunch(runner: LaunchRunner): boolean {
    if (this.state !== "opening" || !this.selectedCard) return false;
    const launch = this.selectedCard.querySelector<HTMLElement>(".vault-hub-launch");
    if (!launch) return false;
    this.unbindLaunchRunner();
    launch.insertAdjacentHTML("beforeend", SKIP_BUTTON_HTML);
    launch.querySelector<HTMLButtonElement>(".launch-overlay-skip")!.addEventListener("click", () => runner.skipActive());
    launch.querySelector(".launch-overlay-progress")?.classList.remove("is-indeterminate");
    const paint = () => renderLaunchPanel(launch, runner.getSnapshot(), this.selectedName);
    const unsubscribe = runner.onChange(paint);
    paint();
    this.unbindLaunch = unsubscribe;
    return true;
  }

  /** The vault finished launching: fade the hub into the workspace. */
  completeLaunch(): void {
    this.close();
  }

  /** Return to the card grid after a failed open, optionally explaining why. */
  reset(error?: unknown): void {
    if (this.state === "closed") return;
    this.endMorph();
    if (error !== undefined) this.showError(error);
  }

  showError(error: unknown): void {
    const el = this.errorEl;
    el.textContent = "";
    el.hidden = false;
    if (error instanceof VaultAccessError) {
      const state = vaultAccessPresentation(error);
      const heading = document.createElement("strong");
      heading.textContent = state.title;
      const message = document.createElement("span");
      message.textContent = state.message;
      const reconnect = document.createElement("button");
      reconnect.type = "button";
      reconnect.className = "vault-hub-reconnect";
      reconnect.textContent = state.action;
      reconnect.disabled = this.actionPending;
      reconnect.addEventListener("click", () => void this.runAction(async () => {
        if (!await this.opts.reconnect(state.vaultId)) {
          message.textContent = "Reconnect canceled. The current vault is still open.";
          return;
        }
        await this.launch(state.vaultId, error.vaultName);
      }));
      el.append(heading, message, reconnect);
      return;
    }
    el.textContent = error instanceof Error ? error.message : "Unable to open that vault";
  }

  // ---- vault packs (ADR 0050) ------------------------------------------------------------------

  private showPack(opener: HTMLElement, source: VaultHubPackSource): void {
    const pack = this.opts.vaultPack;
    if (!pack || this.state !== "browsing") return;
    this.errorEl.hidden = true;
    pack.show(this.root, opener, source, (created) => this.adoptCreated(created)).catch((error) => this.showError(error));
  }

  /** Drop target for `.vault` files, plus the organization-vaults list (loaded lazily, hidden when empty). */
  private mountPackSurfaces(content: HTMLElement, root: HTMLElement): void {
    const pack = this.opts.vaultPack!;
    root.addEventListener("dragover", (event) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault();
    });
    root.addEventListener("drop", (event) => {
      const file = Array.from(event.dataTransfer?.files ?? []).find((f) => f.name.toLowerCase().endsWith(".vault"));
      if (!file) return;
      event.preventDefault();
      this.showPack(root, { kind: "dropped", file });
    });

    const section = document.createElement("div");
    section.className = "vault-hub-org vault-picker-org";
    section.hidden = true;
    content.appendChild(section);
    void pack.listOrganization().then((packs) => {
      if (!packs.length || this.state === "closed") return;
      const heading = document.createElement("h3");
      heading.textContent = "Organization vaults";
      section.appendChild(heading);
      for (const entry of packs) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "vault-picker-recent vault-picker-org-pack";
        const dot = document.createElement("span");
        dot.className = "vault-picker-dot";
        dot.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = entry.name ? `${entry.name} ${entry.version ?? ""}`.trim() : `${entry.fileName} (unavailable: ${entry.error ?? "unreadable"})`;
        row.append(dot, label);
        if (entry.name) row.addEventListener("click", () => this.showPack(row, { kind: "path", path: entry.path }));
        else row.disabled = true;
        section.appendChild(row);
      }
      section.hidden = false;
    }, () => {});
  }

  // ---- rendering -------------------------------------------------------------------------------

  private renderCards(): void {
    this.grid.textContent = "";
    for (const entry of this.entries) this.grid.appendChild(this.buildCard(entry));
    for (const add of this.addCards()) this.grid.appendChild(add);
    this.syncEmptyState();
  }

  private syncEmptyState(): void {
    const empty = this.entries.length === 0;
    this.root.classList.toggle("is-empty", empty);
    this.subtitleEl.textContent = empty
      ? "Your knowledge base, on local Markdown files."
      : "Choose a vault to open";
  }

  private buildCard(entry: VaultHubEntry, transient = false): HTMLElement {
    const isCurrent = entry.path === this.opts.currentPath;
    const card = document.createElement("div");
    card.className = "vault-hub-card";
    card.dataset.path = entry.path;
    card.tabIndex = -1;
    if (isCurrent) card.classList.add("is-current");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "vault-hub-card-main";
    const avatar = document.createElement("span");
    avatar.className = "vault-hub-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "vault-hub-card-text";
    const name = document.createElement("span");
    name.className = "vault-hub-card-name";
    const detail = document.createElement("span");
    detail.className = "vault-hub-card-path";
    text.append(name, detail);
    main.append(avatar, text);
    if (isCurrent) {
      const tag = document.createElement("span");
      tag.className = "vault-hub-tag";
      tag.textContent = "Open in this window";
      main.appendChild(tag);
    }
    card.appendChild(main);
    this.paintEntry(card, entry);

    const launch = document.createElement("div");
    launch.className = "vault-hub-launch";
    launch.setAttribute("role", "status");
    launch.setAttribute("aria-live", "polite");
    card.appendChild(launch);

    if (!transient) {
      main.addEventListener("click", () => this.activate(entry));
      const items = this.menuItems(entry);
      if (items.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "vault-hub-more";
        more.setAttribute("aria-haspopup", "menu");
        more.setAttribute("aria-expanded", "false");
        more.setAttribute("aria-label", `Actions for ${entry.name}`);
        setIcon(more, "ellipsis");
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          this.toggleMenu(card, more, entry);
        });
        card.appendChild(more);
        card.addEventListener("contextmenu", (event) => {
          if (this.state !== "browsing" || this.actionPending) return;
          event.preventDefault();
          this.openMenu(card, more, entry);
        });
      }
    }
    return card;
  }

  private paintEntry(card: HTMLElement, entry: VaultHubEntry): void {
    const avatar = card.querySelector<HTMLElement>(".vault-hub-avatar")!;
    avatar.textContent = vaultInitial(entry.name);
    avatar.style.background = vaultAvatarColor(entry.name);
    card.querySelector<HTMLElement>(".vault-hub-card-name")!.textContent = entry.name;
    const detail = card.querySelector<HTMLElement>(".vault-hub-card-path")!;
    detail.textContent = entry.detail;
    detail.title = entry.detail;
    card.querySelector<HTMLButtonElement>(".vault-hub-more")?.setAttribute("aria-label", `Actions for ${entry.name}`);
  }

  private updateEntry(path: string, described: { name: string; detail: string }): void {
    const entry = this.entries.find((candidate) => candidate.path === path);
    if (!entry) return;
    entry.name = described.name;
    entry.detail = described.detail;
    const card = this.cardFor(path);
    if (card) this.paintEntry(card, entry);
  }

  private addCards(): HTMLElement[] {
    const cards: HTMLElement[] = [];
    const add = (id: string, label: string, icon: string, run: (button: HTMLButtonElement) => void) => {
      const card = document.createElement("div");
      card.className = "vault-hub-card is-add";
      card.dataset.action = id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vault-hub-card-main";
      const glyph = document.createElement("span");
      glyph.className = "vault-hub-add-icon";
      glyph.setAttribute("aria-hidden", "true");
      setIcon(glyph, icon);
      const text = document.createElement("span");
      text.className = "vault-hub-add-label";
      text.textContent = label;
      button.append(glyph, text);
      button.addEventListener("click", () => run(button));
      card.appendChild(button);
      cards.push(card);
    };

    const chooseAndOpen = (choose: () => Promise<string | null>) => () => void this.runAction(async () => {
      const chosen = await choose();
      if (chosen) await this.launch(chosen, vaultNameFromPath(chosen));
    });

    if (this.opts.ios) {
      for (const action of mobileVaultActions(this.opts.externalVaultFolder)) {
        add(action.id, action.label, action.id === "managed" ? "smartphone" : "folder-open",
          chooseAndOpen(action.id === "managed" ? this.opts.chooseFolder : this.opts.chooseExternalFolder));
      }
      return cards;
    }
    const showCreate = this.opts.showCreateVault;
    if (showCreate) {
      add("create", "Create new vault", "plus", (button) => showCreate(this.root, button, (created) =>
        this.runAction(() => this.launch(created, vaultNameFromPath(created)))));
    }
    const pack = this.opts.vaultPack;
    if (pack && showCreate) {
      add("pack", "Create vault from pack\u2026", "package", (button) => this.showPack(button, { kind: "pick" }));
    }
    add("open-folder", "Open folder as vault", "folder-open", chooseAndOpen(this.opts.chooseFolder));
    // Desktop's "external folder" is the same native dialog as "Open folder", so a second card would only be noise there.
    if (this.opts.externalVaultFolder && !this.opts.canOpenInNewWindow) {
      add("choose-files", "Choose folder in Files", "folder", chooseAndOpen(this.opts.chooseExternalFolder));
    }
    const explore = this.opts.exploreSample;
    if (explore) {
      add("sample", "Try the sample vault", "sparkles", () => void this.runAction(async () => {
        const result = await explore();
        if (!result) return;
        await this.launch(result.path, vaultNameFromPath(result.path));
        await result.onOpened?.();
      }));
    }
    return cards;
  }

  // ---- actions ---------------------------------------------------------------------------------

  private activate(entry: VaultHubEntry): void {
    if (entry.path === this.opts.currentPath) {
      this.close();
      return;
    }
    void this.runAction(() => this.launch(entry.path, entry.name));
  }

  private menuItems(entry: VaultHubEntry): MenuItem[] {
    const items: MenuItem[] = [];
    const isCurrent = entry.path === this.opts.currentPath;
    if (this.opts.mode === "switcher" && this.opts.canOpenInNewWindow && !isCurrent) {
      items.push({
        label: "Open in new window",
        icon: "app-window",
        run: () => void this.runAction(() => this.launch(entry.path, entry.name, true)),
      });
    }
    const remove = this.opts.removeFromList;
    if (remove && !isCurrent) {
      items.push({
        label: "Remove from list",
        icon: "trash-2",
        danger: true,
        run: () => void this.runAction(async () => {
          await remove(entry.path);
          this.removeEntry(entry.path);
        }),
      });
    }
    return items;
  }

  private removeEntry(path: string): void {
    const card = this.cardFor(path);
    const mains = this.cardMains();
    const index = card ? mains.indexOf(card.querySelector<HTMLElement>(".vault-hub-card-main")!) : -1;
    this.entries = this.entries.filter((entry) => entry.path !== path);
    card?.remove();
    this.syncEmptyState();
    const after = this.cardMains();
    after[Math.min(Math.max(index, 0), after.length - 1)]?.focus();
  }

  /** Serialises vault actions, disables the surface while one runs, and reports failures inline. */
  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.actionPending || this.state === "closed") return;
    this.actionPending = true;
    this.setButtonsDisabled(true);
    try {
      await action();
    } catch (error) {
      this.endMorph();
      this.showError(error);
    } finally {
      this.actionPending = false;
      // A morphed card stays inert: a reload, the launch runner or reset() ends it.
      if (this.state === "browsing") this.setButtonsDisabled(false);
    }
  }

  private setButtonsDisabled(disabled: boolean): void {
    if (disabled) this.closeMenu();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button")) {
      if (!disabled && button.closest(".vault-create-overlay")) continue;
      button.disabled = disabled;
    }
  }

  private async launch(path: string, name: string, newWindow = false): Promise<void> {
    this.beginMorph(path, name);
    const outcome = await this.opts.openVault(path, { newWindow });
    // reset() (first-run failure) or close() (launch finished) may have run while we waited.
    if (this.state !== "opening") return;
    if (outcome === "dismiss") this.close();
  }

  // ---- morph -----------------------------------------------------------------------------------

  /**
   * Collapse every other card and expand the chosen one in place into the launch
   * panel (FLIP: measure, re-layout, animate the difference). Under
   * prefers-reduced-motion nothing moves; the panel simply appears.
   */
  private beginMorph(path: string, name: string): void {
    if (this.state !== "browsing") return;
    this.state = "opening";
    this.selectedName = name;
    this.closeMenu();
    this.errorEl.hidden = true;
    this.root.classList.remove("is-first-run");
    this.root.classList.add("is-opening");

    let card = this.cardFor(path);
    if (!card) {
      // Opened from "Open folder" / "Create": no card exists yet, so make one to expand.
      card = this.buildCard({ path, name, detail: path }, true);
      this.transientCard = card;
      this.grid.prepend(card);
    }
    this.selectedCard = card;
    card.classList.add("is-selected");
    const launch = card.querySelector<HTMLElement>(".vault-hub-launch")!;
    launch.innerHTML = LAUNCH_PANEL_HTML;
    launch.querySelector(".launch-overlay-progress")!.classList.add("is-indeterminate");
    launch.querySelector<HTMLElement>(".launch-overlay-subtitle")!.textContent = `Opening ${name}…`;

    const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const first = card.getBoundingClientRect();
    const others = [...this.grid.children].filter((child) => child !== card) as HTMLElement[];
    for (const other of others) other.classList.add("is-leaving");

    const expand = () => {
      this.morphTimer = null;
      this.grid.classList.add("is-morphed");
      card.classList.add("is-expanded");
      if (!reduceMotion) {
        const last = card.getBoundingClientRect();
        card.animate(
          [
            { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px)`, width: `${first.width}px` },
            { transform: "translate(0, 0)", width: `${last.width}px` },
          ],
          { duration: MORPH_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
      }
      card.focus({ preventScroll: true });
    };
    if (reduceMotion) expand();
    else this.morphTimer = setTimeout(expand, SIBLING_FADE_MS);
  }

  /** Undo the morph and put the grid back as it was. */
  private endMorph(): void {
    if (this.state !== "opening") return;
    this.cancelMorphTimer();
    this.unbindLaunchRunner();
    const card = this.selectedCard;
    card?.getAnimations().forEach((animation) => animation.cancel());
    this.grid.classList.remove("is-morphed");
    for (const child of this.grid.children) child.classList.remove("is-leaving", "is-selected", "is-expanded");
    card?.querySelector(".vault-hub-launch")?.replaceChildren();
    this.transientCard?.remove();
    this.transientCard = null;
    this.selectedCard = null;
    this.root.classList.remove("is-opening");
    this.state = "browsing";
    this.setButtonsDisabled(false);
    (card?.isConnected ? card.querySelector<HTMLElement>(".vault-hub-card-main") : this.cardMains()[0])?.focus();
  }

  private cancelMorphTimer(): void {
    if (this.morphTimer) clearTimeout(this.morphTimer);
    this.morphTimer = null;
  }

  private unbindLaunchRunner(): void {
    this.unbindLaunch?.();
    this.unbindLaunch = null;
  }

  // ---- menu ------------------------------------------------------------------------------------

  private toggleMenu(card: HTMLElement, opener: HTMLElement, entry: VaultHubEntry): void {
    if (this.menuEl && this.menuOpener === opener) this.closeMenu();
    else this.openMenu(card, opener, entry);
  }

  private openMenu(card: HTMLElement, opener: HTMLElement, entry: VaultHubEntry): void {
    this.closeMenu();
    const items = this.menuItems(entry);
    if (!items.length) return;
    const menu = document.createElement("div");
    menu.className = "vault-hub-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `${entry.name} actions`);
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vault-hub-menu-item";
      if (item.danger) button.classList.add("is-danger");
      button.setAttribute("role", "menuitem");
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      setIcon(icon, item.icon);
      const label = document.createElement("span");
      label.textContent = item.label;
      button.append(icon, label);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.closeMenu(false);
        item.run();
      });
      menu.appendChild(button);
    }
    card.appendChild(menu);
    opener.setAttribute("aria-expanded", "true");
    this.menuEl = menu;
    this.menuOpener = opener;
    card.classList.add("is-menu-open");
    menu.querySelector<HTMLElement>("button")?.focus();
  }

  private closeMenu(restoreFocus = true): void {
    const menu = this.menuEl;
    if (!menu) return;
    const opener = this.menuOpener;
    menu.closest(".vault-hub-card")?.classList.remove("is-menu-open");
    menu.remove();
    opener?.setAttribute("aria-expanded", "false");
    this.menuEl = null;
    this.menuOpener = null;
    if (restoreFocus && opener?.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus();
  }

  // ---- keyboard --------------------------------------------------------------------------------

  private cardMains(): HTMLElement[] {
    return [...this.grid.querySelectorAll<HTMLElement>(".vault-hub-card-main:not(:disabled)")];
  }

  private cardFor(path: string): HTMLElement | null {
    for (const card of this.grid.querySelectorAll<HTMLElement>(".vault-hub-card[data-path]")) {
      if (card.dataset.path === path) return card;
    }
    return null;
  }

  private gridColumns(): number {
    const tracks = getComputedStyle(this.grid).gridTemplateColumns;
    return tracks && tracks !== "none" ? tracks.split(" ").length : 1;
  }

  private onKeydown(event: KeyboardEvent): void {
    // Keep key events from reaching listeners behind the hub (command hotkeys are gated by captureKeys).
    event.stopPropagation();
    const target = event.target as HTMLElement;

    if (event.key === "Escape") {
      if (this.menuEl) {
        event.preventDefault();
        this.closeMenu();
      } else if (this.opts.mode === "switcher" && this.state === "browsing" && !this.root.querySelector(".vault-create-overlay")) {
        event.preventDefault();
        this.close();
      }
      return;
    }

    if (this.menuEl?.contains(target)) {
      this.onMenuKeydown(event);
      return;
    }

    if (event.key === "Tab") {
      this.trapTab(event);
      return;
    }

    if (this.root.querySelector(".vault-create-overlay")) return;
    const main = target.closest<HTMLElement>(".vault-hub-card-main");
    if (!main) return;

    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const card = main.closest<HTMLElement>(".vault-hub-card[data-path]");
      const more = card?.querySelector<HTMLElement>(".vault-hub-more");
      const entry = this.entries.find((candidate) => candidate.path === card?.dataset.path);
      if (card && more && entry && this.state === "browsing") {
        event.preventDefault();
        this.openMenu(card, more, entry);
      }
      return;
    }

    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      const mains = this.cardMains();
      const next = nextHubCardIndex(mains.length, mains.indexOf(main), event.key as HubNavKey, this.gridColumns());
      if (next >= 0) {
        event.preventDefault();
        mains[next].focus();
      }
    }
  }

  private onMenuKeydown(event: KeyboardEvent): void {
    const items = [...this.menuEl!.querySelectorAll<HTMLElement>("button")];
    const index = items.indexOf(event.target as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (event.key === "Tab") {
      event.preventDefault();
      this.closeMenu();
    }
  }

  /** Keep Tab inside the hub (and inside the create dialog while it is up), as a modal should. */
  private trapTab(event: KeyboardEvent): void {
    if (this.root.querySelector(".vault-create-overlay")) return; // the dialog traps its own focus
    const focusable = [...this.root.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !this.root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
}

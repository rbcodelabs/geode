import type { View } from "../workspace";
import type { App } from "../app";
import type { TFile } from "../types";
import type { RenderScope } from "./render-ownership";

export interface BackgroundEditCapture { input: HTMLInputElement; current(): boolean }
interface Interval { host: HTMLElement; entering: boolean; current(): boolean; edits: BackgroundEditCapture[] }

/** Private source-owner authority, separate from navigation, close and sync guards. */
export class BackgroundVisibility {
  private captures = new Set<() => BackgroundEditCapture | null>();
  private interval: Interval | null = null;
  constructor(private captureOwner: () => (() => boolean) | null) {}
  register(capture: () => BackgroundEditCapture | null): () => void {
    this.captures.add(capture);
    return () => { this.captures.delete(capture); this.reveal(); };
  }
  beginHide(host: HTMLElement): () => void {
    const current = this.captureOwner();
    if (!current || !current()) return () => {};
    const edits = [...this.captures].map(capture => capture()).filter((edit): edit is BackgroundEditCapture => edit !== null);
    if (!edits.length) return () => {};
    this.reveal();
    const interval: Interval = { host, entering: true, current, edits };
    this.interval = interval;
    document.addEventListener("pointerdown", this.deliberate, true);
    document.addEventListener("keydown", this.deliberate, true);
    document.addEventListener("visibilitychange", this.visibilityChanged, true);
    window.addEventListener("blur", this.windowBlur);
    return () => {
      if (this.interval !== interval) return;
      interval.entering = false;
      if (!this.hidden(interval) || !current()) this.reveal();
    };
  }
  preserves(input: HTMLInputElement): boolean {
    const interval = this.interval;
    if (!interval) return false;
    if (!interval.current() || !interval.host.isConnected || document.hidden || (!interval.entering && !this.hidden(interval))) { this.reveal(); return false; }
    const edit = interval.edits.find(edit => edit.input === input);
    if (!edit || !edit.current()) { this.reveal(); return false; }
    return true;
  }
  reveal(): void {
    this.interval = null;
    document.removeEventListener("pointerdown", this.deliberate, true);
    document.removeEventListener("keydown", this.deliberate, true);
    document.removeEventListener("visibilitychange", this.visibilityChanged, true);
    window.removeEventListener("blur", this.windowBlur);
  }
  private hidden(interval: Interval): boolean { return !interval.host.classList.contains("mod-active"); }
  private deliberate = () => { this.reveal(); };
  private windowBlur = () => { this.reveal(); };
  private visibilityChanged = () => { if (document.hidden) this.reveal(); };
}

/** The lazy leaf is resolved at transition time, never from the active global pane. */
export function nativeBackgroundVisibility(app: App, view: View & { file: TFile | null; renderOwner: RenderScope }, revision: () => readonly unknown[]): BackgroundVisibility {
  return new BackgroundVisibility(() => {
    const leaf = app.workspace.findLeafForView(view), file = view.file, filePath = file?.path;
    const container = view.containerEl, parent = container.parentElement, vault = app.vault, root = vault.root;
    const versions = revision();
    let token: ReturnType<RenderScope["captureToken"]>;
    // This capture is optional; a concurrent workspace barrier owns admission.
    // Declining visibility authority must not change its ordinary activation.
    try { token = view.renderOwner.captureToken(); }
    catch { return null; }
    if (!leaf || leaf.view !== view || !file || !container.isConnected) return null;
    return () => {
      try {
        token.check();
        return app.workspace.findLeafForView(view) === leaf && leaf.view === view && view.file === file && file.path === filePath &&
          app.vault === vault && vault.root === root && view.containerEl === container && container.isConnected && container.parentElement === parent &&
          revision().every((value, index) => Object.is(value, versions[index]));
      } catch { return false; }
    };
  });
}

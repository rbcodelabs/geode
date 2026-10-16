import type { App } from "../app";
import { Plugin } from "../plugin";
import { FootnotesView } from "../views/footnotes-view";

export class FootnotesPlugin extends Plugin {
  private opening: Promise<void> | null = null;
  private accepting = true;
  constructor(app: App) {
    super(app, { id: "footnotes", name: "Footnotes", version: "1.0.0", minAppVersion: "0.1.0", description: "View and edit footnotes in the active note.", author: "Geode" });
  }
  onload(): void {
    this.registerView("footnotes", () => new FootnotesView(this.app));
    this.addCommand({ id: "open", name: "Show footnotes", callback: () => this.open() });
  }
  private open(): Promise<void> {
    if (!this.accepting || !this.loaded) return Promise.resolve();
    if (this.opening) return this.opening;
    const workspace = this.app.workspace;
    const operation = (async () => {
      let leaf = workspace.getLeavesOfType("footnotes")[0];
      if (!leaf) { leaf = workspace.getRightLeaf(false); await leaf.setViewState({ type: "footnotes", active: true }); }
      if (!this.accepting || !this.loaded || workspace !== this.app.workspace) { await leaf.detach(); return; }
      workspace.revealLeaf(leaf);
    })();
    this.opening = operation;
    void operation.finally(() => { if (this.opening === operation) this.opening = null; }).catch(() => undefined);
    return operation;
  }
  /** Serialize pane creation before disable so late opens cannot resurrect it. */
  async stop(): Promise<void> {
    this.accepting = false;
    await this.opening?.catch(() => undefined);
    await this.app.workspace.detachLeavesOfType("footnotes");
    await this.unloadAndWait();
  }
  onunload(): void { this.accepting = false; }
}

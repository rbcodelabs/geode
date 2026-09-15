import type { App } from "../app";
import type { View } from "../workspace";
import type { TFile } from "../types";

export class CommentsView implements View {
  readonly viewType = "comments";
  readonly containerEl = document.createElement("div");
  private bodyEl = document.createElement("div");
  private file: TFile | null = null;
  private includeResolved = false;

  constructor(private app: App) {
    this.containerEl.className = "sidebar-view comments-view";
    const header = document.createElement("div");
    header.className = "sidebar-view-header";
    const title = document.createElement("span");
    title.className = "sidebar-view-title";
    title.textContent = "Comments";
    const toggle = document.createElement("label");
    toggle.className = "comments-resolved-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => { this.includeResolved = input.checked; this.render(); });
    toggle.append(input, " Include resolved");
    header.append(title, toggle);
    this.bodyEl.className = "sidebar-view-body";
    this.containerEl.append(header, this.bodyEl);
    app.workspace.on("file-open", () => this.syncActiveFile());
    // file-open is emitted only when the newly active leaf's view answers
    // getFile(), so switching to a fileless view (a web view, say) emits
    // nothing and would strand the previous note's comments on screen.
    // active-leaf-change is the unconditional signal.
    app.workspace.on("active-leaf-change", () => this.syncActiveFile());
    // Swapping a leaf's view in place (opening an HTML file over the active
    // markdown tab) goes through WorkspaceLeaf.setView, which emits neither
    // active-leaf-change nor file-open — layout-change is its only signal.
    app.workspace.on("layout-change", () => this.syncActiveFile());
    app.comments.on("changed", (file) => { if (file.path === this.file?.path) this.render(); });
  }

  getDisplayText(): string { return "Comments"; }
  getIcon(): string { return "message-square"; }
  onOpen(): void { this.file = this.app.workspace.getActiveFile(); this.render(); }
  onClose(): void {}

  /**
   * Recompute the subject from the live active leaf rather than from an event
   * payload. Workspace.getActiveFile() reads `activeGroup.active`, which is
   * null-yielding for a fileless view but unchanged while a sidebar leaf holds
   * focus (TabGroup.setActiveLeaf calls setActiveGroup only when
   * `!this.sidebar`) — so clicking into this panel never blanks it.
   */
  private syncActiveFile(): void {
    const next = this.app.workspace.getActiveFile();
    if ((next?.path ?? null) === (this.file?.path ?? null)) return;
    this.file = next;
    this.render();
  }

  render(): void {
    this.bodyEl.replaceChildren();
    if (!this.file || this.file.extension !== "md") return this.empty("No file is open.");
    const parsed = this.app.comments.inspect(this.file);
    if (parsed.errors.length) {
      const warning = document.createElement("div");
      warning.className = "comments-warning";
      warning.setAttribute("role", "alert");
      warning.textContent = "Some comment markers are malformed. Repair them in Source mode before editing comments.";
      this.bodyEl.append(warning);
    }
    const threads = this.app.comments.list(this.file, { includeResolved: this.includeResolved });
    if (!threads.length) return this.empty(parsed.errors.length ? "No editable comments." : "No comments in this note.");
    for (const thread of threads) {
      const card = document.createElement("section");
      card.className = "comment-thread";
      card.dataset.commentId = thread.id;
      card.tabIndex = 0;
      card.setAttribute("aria-label", `Comment on ${thread.detached ? "deleted text" : thread.anchorText}`);
      const anchor = document.createElement("button");
      anchor.type = "button";
      anchor.className = "comment-anchor-preview";
      anchor.textContent = thread.detached ? "Detached comment" : thread.anchorText;
      anchor.addEventListener("click", () => this.app.revealComment(thread));
      card.append(anchor);
      for (const item of thread.messages) {
        const message = document.createElement("div");
        message.className = "comment-message";
        const byline = document.createElement("strong");
        byline.textContent = `${item.author.name}${item.author.type === "agent" ? " · Agent" : ""}`;
        const body = document.createElement("div");
        body.className = "comment-message-body";
        body.textContent = item.body;
        const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit";
        edit.addEventListener("click", () => this.app.promptEditComment(thread, item));
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Delete";
        remove.addEventListener("click", () => this.app.reportCommentMutation(this.app.comments.deleteMessage(this.file!, thread.id, item.id)));
        message.append(byline, body, edit, remove); card.append(message);
      }
      const reply = document.createElement("button"); reply.type = "button"; reply.textContent = "Reply";
      reply.addEventListener("click", () => this.app.promptReplyComment(thread));
      const resolve = document.createElement("button"); resolve.type = "button"; resolve.textContent = thread.resolvedAt ? "Reopen" : "Resolve";
      resolve.addEventListener("click", () => this.app.reportCommentMutation(thread.resolvedAt ? this.app.comments.reopen(this.file!, thread.id) : this.app.comments.resolve(this.file!, thread.id)));
      const removeThread = document.createElement("button"); removeThread.type = "button"; removeThread.textContent = "Delete thread";
      removeThread.addEventListener("click", () => { if (confirm("Delete this comment thread?")) this.app.reportCommentMutation(this.app.comments.deleteThread(this.file!, thread.id)); });
      card.append(reply, resolve);
      if (thread.detached) {
        const reattach = document.createElement("button"); reattach.type = "button"; reattach.textContent = "Reattach to selection";
        reattach.addEventListener("click", () => this.app.reattachComment(thread));
        card.append(reattach);
      }
      card.append(removeThread);
      this.bodyEl.append(card);
    }
  }

  selectThread(threadId: string): void {
    for (const card of this.bodyEl.querySelectorAll<HTMLElement>(".comment-thread")) {
      card.classList.toggle("is-active", card.dataset.commentId === threadId);
    }
    const card = this.bodyEl.querySelector<HTMLElement>(`.comment-thread[data-comment-id="${CSS.escape(threadId)}"]`);
    card?.focus();
    card?.scrollIntoView({ block: "nearest" });
  }

  private empty(message: string): void {
    const empty = document.createElement("div"); empty.className = "pane-empty"; empty.textContent = message; this.bodyEl.append(empty);
  }
}

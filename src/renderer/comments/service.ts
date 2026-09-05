import { Events, type EventRef } from "../events";
import type { TFile } from "../types";
import type { Vault } from "../vault";
import {
  CommentFormatError,
  createCommentMarkers,
  parseCommentThreads,
  validateCommentRange,
  type CommentAuthor,
  type CommentMessage,
  type CommentPayload,
  type ParsedCommentThread,
} from "./model";

export type { CommentAuthor, CommentMessage } from "./model";

export interface CommentThread extends ParsedCommentThread {
  file: TFile;
}

export interface OpenCommentEditor {
  getText(): string;
  applyCommentMutation(mutator: (source: string) => string): Promise<void>;
}

export class StaleCommentWriteError extends Error {}

const MAX_BODY_LENGTH = 20_000;
const MAX_MESSAGES = 500;

function cleanBody(body: string): string {
  const result = body.trim();
  if (!result) throw new CommentFormatError("Comment bodies cannot be blank");
  if (result.length > MAX_BODY_LENGTH) throw new CommentFormatError("Comment bodies cannot exceed 20,000 characters");
  return result;
}

function cleanAuthor(author: CommentAuthor): CommentAuthor {
  const name = author.name.trim();
  if (!name || (author.type !== "user" && author.type !== "agent")) throw new CommentFormatError("A valid comment author is required");
  return { type: author.type, name };
}

function message(body: string, author: CommentAuthor): CommentMessage {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), author: cleanAuthor(author), body: cleanBody(body), createdAt: now, updatedAt: now };
}

function replacePayload(source: string, thread: ParsedCommentThread, payload: CommentPayload): string {
  const marker = createCommentMarkers(thread.id, payload).open;
  return source.slice(0, thread.openFrom) + marker + source.slice(thread.openTo);
}

export class CommentService extends Events {
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private vault: Pick<Vault, "cachedRead" | "modify"> & Partial<Pick<Vault, "read" | "getCachedContent">>,
    private openEditor: (file: TFile) => OpenCommentEditor | null = () => null,
  ) { super(); }

  override on(name: "changed", callback: (file: TFile) => void): EventRef;
  override on(name: string, callback: (...args: any[]) => any): EventRef {
    return super.on(name, callback);
  }

  list(file: TFile, options: { includeResolved?: boolean } = {}): CommentThread[] {
    const source = this.openEditor(file)?.getText() ?? this.vault.getCachedContent?.(file.path) ?? "";
    return parseCommentThreads(source).threads
      .filter((thread) => options.includeResolved || !thread.resolvedAt)
      .map((thread) => ({ ...thread, file }));
  }

  inspect(file: TFile) {
    const source = this.openEditor(file)?.getText() ?? this.vault.getCachedContent?.(file.path) ?? "";
    return parseCommentThreads(source);
  }

  async create(file: TFile, range: { from: number; to: number }, body: string, author: CommentAuthor): Promise<CommentThread> {
    const first = message(body, author);
    const id = crypto.randomUUID();
    await this.mutate(file, (source) => {
      validateCommentRange(source, range);
      const markers = createCommentMarkers(id, { messages: [first] });
      return source.slice(0, range.from) + markers.open + source.slice(range.from, range.to) + markers.close + source.slice(range.to);
    });
    return this.requireThread(file, id);
  }

  async reply(file: TFile, threadId: string, body: string, author: CommentAuthor): Promise<CommentMessage> {
    const next = message(body, author);
    await this.updateThread(file, threadId, (thread) => {
      if (thread.messages.length >= MAX_MESSAGES) throw new CommentFormatError("A thread cannot exceed 500 messages");
      return { messages: [...thread.messages, next], ...(thread.resolvedAt ? { resolvedAt: thread.resolvedAt } : {}) };
    });
    return next;
  }

  async editMessage(file: TFile, threadId: string, messageId: string, body: string): Promise<void> {
    const clean = cleanBody(body);
    await this.updateThread(file, threadId, (thread) => {
      if (!thread.messages.some((item) => item.id === messageId)) throw new CommentFormatError("Comment message not found");
      return { messages: thread.messages.map((item) => item.id === messageId ? { ...item, body: clean, updatedAt: new Date().toISOString() } : item), ...(thread.resolvedAt ? { resolvedAt: thread.resolvedAt } : {}) };
    });
  }

  async deleteMessage(file: TFile, threadId: string, messageId: string): Promise<void> {
    await this.mutate(file, (source) => {
      const thread = this.findThread(source, threadId);
      const messages = thread.messages.filter((item) => item.id !== messageId);
      if (messages.length === thread.messages.length) throw new CommentFormatError("Comment message not found");
      if (!messages.length) return source.slice(0, thread.openFrom) + source.slice(thread.openTo, thread.closeFrom) + source.slice(thread.closeTo);
      return replacePayload(source, thread, { messages, ...(thread.resolvedAt ? { resolvedAt: thread.resolvedAt } : {}) });
    });
  }

  async deleteThread(file: TFile, threadId: string): Promise<void> {
    await this.mutate(file, (source) => {
      const thread = this.findThread(source, threadId);
      return source.slice(0, thread.openFrom) + source.slice(thread.openTo, thread.closeFrom) + source.slice(thread.closeTo);
    });
  }

  async resolve(file: TFile, threadId: string): Promise<void> {
    await this.updateThread(file, threadId, (thread) => thread.resolvedAt ? null : { messages: thread.messages, resolvedAt: new Date().toISOString() });
  }

  async reopen(file: TFile, threadId: string): Promise<void> {
    await this.updateThread(file, threadId, (thread) => thread.resolvedAt ? { messages: thread.messages } : null);
  }

  async reattach(file: TFile, threadId: string, range: { from: number; to: number }): Promise<void> {
    await this.mutate(file, (source) => {
      const thread = this.findThread(source, threadId);
      if (!thread.detached) throw new CommentFormatError("Only detached comments can be reattached");
      if (range.from < thread.markerTo && range.to > thread.markerFrom) {
        throw new CommentFormatError("A reattachment selection cannot cross the detached marker pair");
      }
      const without = source.slice(0, thread.markerFrom) + source.slice(thread.markerTo);
      const removedLength = thread.markerTo - thread.markerFrom;
      const adjusted = range.from >= thread.markerTo
        ? { from: range.from - removedLength, to: range.to - removedLength }
        : range;
      validateCommentRange(without, adjusted);
      const markers = createCommentMarkers(thread.id, { messages: thread.messages, ...(thread.resolvedAt ? { resolvedAt: thread.resolvedAt } : {}) });
      return without.slice(0, adjusted.from) + markers.open + without.slice(adjusted.from, adjusted.to) + markers.close + without.slice(adjusted.to);
    });
  }

  private async updateThread(file: TFile, threadId: string, update: (thread: ParsedCommentThread) => CommentPayload | null): Promise<void> {
    await this.mutate(file, (source) => {
      const thread = this.findThread(source, threadId);
      const payload = update(thread);
      return payload ? replacePayload(source, thread, payload) : source;
    });
  }

  private findThread(source: string, threadId: string): ParsedCommentThread {
    const parsed = parseCommentThreads(source);
    if (parsed.errors.length) throw new CommentFormatError("Malformed comment markers are read-only until repaired");
    const thread = parsed.threads.find((item) => item.id === threadId);
    if (!thread) throw new CommentFormatError("Comment thread not found");
    return thread;
  }

  private requireThread(file: TFile, threadId: string): CommentThread {
    const thread = this.list(file, { includeResolved: true }).find((item) => item.id === threadId);
    if (!thread) throw new CommentFormatError("Comment thread not found after mutation");
    return thread;
  }

  private mutate(file: TFile, transform: (source: string) => string): Promise<void> {
    const previous = this.queues.get(file.path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const editor = this.openEditor(file);
      if (editor) {
        await editor.applyCommentMutation(transform);
      } else {
        const source = await this.vault.cachedRead(file);
        const result = transform(source);
        if (result === source) return;
        // `cachedRead()` intentionally returns a warmed snapshot. The guard must
        // bypass it so provider/external edits are visible immediately. Hosts do
        // not currently expose compare-and-swap, so a small read→write TOCTOU
        // window remains; per-file serialization closes the in-process half.
        const latest = this.vault.read ? await this.vault.read(file) : await this.vault.cachedRead(file);
        if (latest !== source) throw new StaleCommentWriteError("The note changed before the comment could be saved");
        await this.vault.modify(file, result);
      }
      this.trigger("changed", file);
    });
    this.queues.set(file.path, operation.catch(() => undefined));
    return operation;
  }
}

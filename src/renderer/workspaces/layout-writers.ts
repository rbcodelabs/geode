/** Internal adapters for built-in writers; plugin lifecycle effects are separate. */
export interface LayoutWriter {
  path: string;
  getText(): string;
  hasChanges(): boolean;
  preflight(): void;
  pause(): Promise<void>;
  settle(): Promise<void>;
  resume(): void;
}
export function preflightLayoutWriters(writers: readonly LayoutWriter[]): void {
  const buffers = new Map<string, { text: string; dirty: boolean; different: boolean }>();
  for (const writer of writers) {
    writer.preflight();
    const previous = buffers.get(writer.path);
    const text = writer.getText();
    const dirty = writer.hasChanges() || previous?.dirty === true;
    const different = previous ? previous.different || previous.text !== text : false;
    if (dirty && different) throw new Error(`Different buffers are open for ${writer.path}. Resolve their edits before loading a workspace.`);
    buffers.set(writer.path, { text: previous?.text ?? text, dirty, different });
  }
}
/** Pause the complete set before any flush; rollback resumes original writers. */
export async function settleLayoutWriters(writers: readonly LayoutWriter[]): Promise<(live?: ReadonlySet<LayoutWriter>) => void> {
  preflightLayoutWriters(writers);
  const paused: LayoutWriter[] = [];
  const resume = (live?: ReadonlySet<LayoutWriter>): void => {
    const failures: unknown[] = [];
    for (const writer of paused.splice(0).reverse()) if (!live || live.has(writer)) { try { writer.resume(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "Could not resume workspace writers.");
  };
  try {
    for (const writer of writers) { paused.push(writer); await writer.pause(); }
    preflightLayoutWriters(writers);
    for (const writer of writers) { writer.preflight(); await writer.settle(); writer.preflight(); if (writer.hasChanges()) throw new Error(`Unacknowledged changes remain in ${writer.path}. The workspace was preserved.`); }
    return resume;
  } catch (error) {
    try { resume(); } catch (resumeError) { throw new AggregateError([error, resumeError], "Could not settle and resume workspace writers."); }
    throw error;
  }
}

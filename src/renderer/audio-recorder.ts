import { resolveAttachmentFolder, uniqueAttachmentPath, type AttachmentVault } from "./attachments";
import type { TFile } from "./types";

/**
 * Pure logic and the recorder state machine for the "Audio recorder" core
 * plugin. Free of DOM/Electron globals (the browser APIs are injected) so the
 * naming, embed and toggle rules can be unit-tested without a microphone.
 */

export const RECORDING_EXTENSION = "webm";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Obsidian's recording name: `Recording YYYYMMDDHHmmss.webm` in local time. */
export function recordingFileName(now: Date, extension = RECORDING_EXTENSION): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Recording ${stamp}.${extension}`;
}

/**
 * True for a file Geode's recorder produced. `.webm` is a video extension (it
 * usually is video), so embeds of recordings are routed to an audio player by
 * their `Recording …` name rather than reclassifying every webm.
 */
export function isAudioRecording(name: string, extension: string): boolean {
  return extension.toLowerCase() === RECORDING_EXTENSION && /^Recording \d{14}(?: \d+)?\.webm$/i.test(name);
}

/**
 * Append `![[linktext]]` to the end of a note on its own line, preserving the
 * note's existing content and ensuring exactly one trailing newline.
 */
export function appendEmbed(content: string, linktext: string): string {
  const separator = content === "" ? "" : content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}![[${linktext}]]\n`;
}

/** The text to insert at the end of an editor document (same shape as `appendEmbed`). */
export function embedInsertion(docText: string, linktext: string): string {
  return appendEmbed(docText, linktext).slice(docText.length);
}

/** Save a recording through the same folder/collision rules as pasted images. */
export async function saveRecording(
  vault: AttachmentVault,
  data: ArrayBuffer,
  options: { sourcePath: string; now?: Date },
): Promise<TFile> {
  const folder = resolveAttachmentFolder(vault.getConfig("attachmentFolderPath"), options.sourcePath);
  if (folder && !vault.getFolderByPath(folder)) await vault.createFolder(folder);
  const existing = (vault.getFolderByPath(folder)?.children ?? []).map((child) => child.name);
  const path = uniqueAttachmentPath(folder, recordingFileName(options.now ?? new Date()), existing);
  return vault.createBinary(path, data);
}

export type RecorderState = "idle" | "starting" | "recording" | "saving";

export interface RecorderLike {
  state: string;
  ondataavailable: ((event: { data: { size: number } }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(): void;
  stop(): void;
}

export interface StreamLike {
  getTracks(): { stop(): void }[];
}

export interface RecorderDeps<Chunk extends { size: number }, Stream extends StreamLike> {
  getUserMedia(): Promise<Stream>;
  createRecorder(stream: Stream): RecorderLike;
  /** Combine the captured chunks into bytes ready to write. */
  toBuffer(chunks: Chunk[]): Promise<ArrayBuffer>;
  /** Persist the recording; errors are reported via `onError`. */
  onRecorded(data: ArrayBuffer): Promise<void>;
  onStateChange(state: RecorderState): void;
  onError(kind: "permission" | "no-device" | "failed", error: unknown): void;
}

/** Classify a getUserMedia rejection into the case the user needs to hear about. */
export function classifyMediaError(error: unknown): "permission" | "no-device" | "failed" {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "permission";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "no-device";
  return "failed";
}

/**
 * Start/stop toggle. Owns the microphone stream: tracks are always stopped when
 * recording ends (normally, on error, or on `dispose`), so the OS microphone
 * indicator never lingers.
 */
export class AudioRecorderController<Chunk extends { size: number }, Stream extends StreamLike> {
  private current: RecorderState = "idle";
  private stream: Stream | null = null;
  private recorder: RecorderLike | null = null;
  private chunks: Chunk[] = [];
  private disposed = false;

  constructor(private deps: RecorderDeps<Chunk, Stream>) {}

  get state(): RecorderState {
    return this.current;
  }

  /** Toggle: idle -> recording, recording -> saving -> idle. Ignored mid-transition. */
  async toggle(): Promise<void> {
    if (this.current === "idle") await this.start();
    else if (this.current === "recording") this.stop();
  }

  private setState(state: RecorderState): void {
    this.current = state;
    this.deps.onStateChange(state);
  }

  private releaseStream(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private async start(): Promise<void> {
    this.setState("starting");
    let stream: Stream;
    try {
      stream = await this.deps.getUserMedia();
    } catch (error) {
      this.setState("idle");
      this.deps.onError(classifyMediaError(error), error);
      return;
    }
    if (this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    try {
      const recorder = this.deps.createRecorder(stream);
      this.stream = stream;
      this.recorder = recorder;
      this.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data as Chunk);
      };
      recorder.onerror = (event) => this.fail(event);
      recorder.onstop = () => void this.finish();
      recorder.start();
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      this.stream = null;
      this.recorder = null;
      this.setState("idle");
      this.deps.onError("failed", error);
      return;
    }
    this.setState("recording");
  }

  private stop(): void {
    this.setState("saving");
    try {
      this.recorder?.stop();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.current === "idle") return;
    this.recorder = null;
    this.chunks = [];
    this.releaseStream();
    this.setState("idle");
    this.deps.onError("failed", error);
  }

  private async finish(): Promise<void> {
    const chunks = this.chunks;
    this.recorder = null;
    this.chunks = [];
    this.releaseStream();
    try {
      if (chunks.length > 0 && !this.disposed) await this.deps.onRecorded(await this.deps.toBuffer(chunks));
    } catch (error) {
      this.deps.onError("failed", error);
    } finally {
      this.setState("idle");
    }
  }

  /** Abandon any in-flight recording and release the microphone (plugin unload). */
  dispose(): void {
    this.disposed = true;
    const recorder = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* already stopped */ }
    }
    this.releaseStream();
    this.current = "idle";
  }
}

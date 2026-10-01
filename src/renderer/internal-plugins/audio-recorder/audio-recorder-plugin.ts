import type { App } from "../../app";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { setIcon } from "../../api/icons";
import {
  AudioRecorderController,
  embedInsertion,
  saveRecording,
  type RecorderLike,
  type RecorderState,
} from "../../audio-recorder";

export const AUDIO_RECORDER_PLUGIN_MANIFEST: PluginManifest = {
  id: "audio-recorder",
  name: "Audio recorder",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Record and save audio recordings directly in a note.",
  author: "Geode",
};

/**
 * Audio recorder core plugin: a ribbon mic icon and one command toggle a
 * MediaRecorder. On stop the webm is saved as a vault attachment and
 * `![[file]]` is appended to the active note.
 */
export class AudioRecorderPlugin extends GeodePlugin {
  private controller: AudioRecorderController<Blob, MediaStream> | null = null;
  private ribbonEl: HTMLButtonElement | null = null;

  constructor(app: App) {
    super(app, AUDIO_RECORDER_PLUGIN_MANIFEST);
  }

  onload(): void {
    const controller = new AudioRecorderController<Blob, MediaStream>({
      getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      createRecorder: (stream) => new MediaRecorder(stream) as unknown as RecorderLike,
      toBuffer: (chunks) => new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }).arrayBuffer(),
      onRecorded: (data) => this.saveAndEmbed(data),
      onStateChange: (state) => this.renderState(state),
      onError: (kind, error) => {
        if (kind === "permission") this.app.notify("Microphone access was denied. Allow microphone access for Geode in system settings.");
        else if (kind === "no-device") this.app.notify("No microphone found.");
        else {
          console.error(error);
          this.app.notify(`Audio recording failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      },
    });
    this.controller = controller;
    this.register(() => { controller.dispose(); this.controller = null; });

    const el = document.createElement("button");
    el.type = "button";
    el.className = "side-dock-ribbon-action audio-recorder-ribbon";
    setIcon(el, "mic");
    el.addEventListener("click", () => void controller.toggle());
    this.ribbonEl = el;
    this.renderState("idle");
    this.app.addRibbonIcon(el);
    this.register(() => { el.remove(); this.ribbonEl = null; });

    this.addCommand({
      id: "start-stop-recording",
      name: "Start/stop recording",
      callback: () => controller.toggle(),
    });
  }

  private renderState(state: RecorderState): void {
    const el = this.ribbonEl;
    if (!el) return;
    const recording = state === "recording";
    const label = recording ? "Stop recording" : "Start recording";
    el.classList.toggle("is-active", recording);
    el.classList.toggle("is-recording", recording);
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-pressed", String(recording));
    el.title = label;
  }

  private async saveAndEmbed(data: ArrayBuffer): Promise<void> {
    const app = this.app;
    const activeFile = app.workspace.getActiveFile();
    const note = activeFile && activeFile.extension === "md" ? activeFile : null;
    const sourcePath = note?.path ?? "";
    const file = await saveRecording(app.vault, data, { sourcePath });
    if (!note) {
      app.notify(`Saved recording to ${file.path}. Open a note to embed it.`);
      return;
    }
    const linktext = app.metadataCache.fileToLinktext(file, sourcePath, false);
    const view = app.getActiveMarkdownView();
    if (view?.editor && view.file?.path === note.path) {
      const length = view.editor.state.doc.length;
      const insert = embedInsertion(view.editor.state.doc.toString(), linktext);
      view.editor.dispatch({ changes: { from: length, insert } });
    } else {
      const content = await app.vault.read(note);
      await app.vault.modify(note, content + embedInsertion(content, linktext));
    }
    app.notify(`Saved recording ${file.name}`);
  }
}

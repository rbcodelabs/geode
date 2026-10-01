import { describe, expect, it, vi } from "vitest";
import {
  AudioRecorderController,
  appendEmbed,
  classifyMediaError,
  embedInsertion,
  isAudioRecording,
  recordingFileName,
  saveRecording,
  type RecorderLike,
  type RecorderState,
} from "../../src/renderer/audio-recorder";

describe("recordingFileName", () => {
  it("formats local time as Recording YYYYMMDDHHmmss.webm", () => {
    expect(recordingFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("Recording 20260102030405.webm");
  });
});

describe("isAudioRecording", () => {
  it("matches recordings but not other webm files", () => {
    expect(isAudioRecording("Recording 20260102030405.webm", "webm")).toBe(true);
    expect(isAudioRecording("Recording 20260102030405 1.webm", "webm")).toBe(true);
    expect(isAudioRecording("clip.webm", "webm")).toBe(false);
  });
});

describe("appendEmbed", () => {
  it("appends on a new line and ends with a newline", () => {
    expect(appendEmbed("hello", "a.webm")).toBe("hello\n![[a.webm]]\n");
    expect(appendEmbed("hello\n", "a.webm")).toBe("hello\n![[a.webm]]\n");
    expect(appendEmbed("", "a.webm")).toBe("![[a.webm]]\n");
  });
  it("embedInsertion is the suffix to add to an editor doc", () => {
    expect(embedInsertion("hi", "a.webm")).toBe("\n![[a.webm]]\n");
    expect(embedInsertion("hi\n", "a.webm")).toBe("![[a.webm]]\n");
  });
});

function fakeVault(config: unknown, existing: Record<string, string[]> = {}) {
  const created: string[] = [];
  const folders = new Set(Object.keys(existing));
  return {
    created,
    vault: {
      getConfig: () => config,
      getFolderByPath: (p: string) => (p === "" || folders.has(p) ? { children: (existing[p] ?? []).map((name) => ({ name })) } : null),
      createFolder: vi.fn(async (p: string) => { folders.add(p); }),
      createBinary: vi.fn(async (p: string) => { created.push(p); return { path: p } as never; }),
    },
  };
}

describe("saveRecording", () => {
  const now = new Date(2026, 0, 2, 3, 4, 5);
  it("saves to the vault root by default", async () => {
    const { vault, created } = fakeVault(undefined);
    await saveRecording(vault, new ArrayBuffer(1), { sourcePath: "n.md", now });
    expect(created).toEqual(["Recording 20260102030405.webm"]);
  });
  it("honours the attachment folder, creating it", async () => {
    const { vault, created } = fakeVault("Files");
    await saveRecording(vault, new ArrayBuffer(1), { sourcePath: "n.md", now });
    expect(vault.createFolder).toHaveBeenCalledWith("Files");
    expect(created).toEqual(["Files/Recording 20260102030405.webm"]);
  });
  it("resolves ./ relative to the note and avoids collisions", async () => {
    const { vault, created } = fakeVault("./media", { "notes/media": ["Recording 20260102030405.webm"] });
    await saveRecording(vault, new ArrayBuffer(1), { sourcePath: "notes/n.md", now });
    expect(created).toEqual(["notes/media/Recording 20260102030405 1.webm"]);
  });
});

describe("classifyMediaError", () => {
  it("maps DOM exception names", () => {
    expect(classifyMediaError({ name: "NotAllowedError" })).toBe("permission");
    expect(classifyMediaError({ name: "NotFoundError" })).toBe("no-device");
    expect(classifyMediaError(new Error("x"))).toBe("failed");
  });
});

function harness(opts: { getUserMedia?: () => Promise<unknown> } = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  let recorder!: RecorderLike & { state: string };
  const states: RecorderState[] = [];
  const recorded: ArrayBuffer[] = [];
  const errors: string[] = [];
  const controller = new AudioRecorderController<{ size: number }, typeof stream>({
    getUserMedia: (opts.getUserMedia as never) ?? (async () => stream),
    createRecorder: () => {
      recorder = {
        state: "inactive", ondataavailable: null, onstop: null, onerror: null,
        start() { this.state = "recording"; },
        stop() { this.state = "inactive"; this.ondataavailable?.({ data: { size: 3 } }); this.onstop?.(); },
      };
      return recorder;
    },
    toBuffer: async () => new ArrayBuffer(3),
    onRecorded: async (d) => { recorded.push(d); },
    onStateChange: (s) => states.push(s),
    onError: (k) => errors.push(k),
  });
  return { controller, track, states, recorded, errors, getRecorder: () => recorder };
}

describe("AudioRecorderController", () => {
  it("toggles idle -> recording -> idle, saving once and releasing the mic", async () => {
    const h = harness();
    await h.controller.toggle();
    expect(h.controller.state).toBe("recording");
    await h.controller.toggle();
    await vi.waitFor(() => expect(h.controller.state).toBe("idle"));
    expect(h.states).toEqual(["starting", "recording", "saving", "idle"]);
    expect(h.recorded).toHaveLength(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
  });
  it("reports permission denial and stays idle", async () => {
    const h = harness({ getUserMedia: async () => { throw Object.assign(new Error("d"), { name: "NotAllowedError" }); } });
    await h.controller.toggle();
    expect(h.errors).toEqual(["permission"]);
    expect(h.controller.state).toBe("idle");
  });
  it("dispose releases the stream without saving", async () => {
    const h = harness();
    await h.controller.toggle();
    h.controller.dispose();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.recorded).toHaveLength(0);
    expect(h.controller.state).toBe("idle");
  });
});

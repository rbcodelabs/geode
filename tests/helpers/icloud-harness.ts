import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IcloudContainerBridge } from "../../src/shared/icloud-container";
import { createContainerLocator, NodeIcloudContainer } from "../../src/sync-node/icloud-container";
import { FakeIcloudBridge } from "./fake-icloud-bridge";

/**
 * One interface over the two bridge implementations so the provider's contract suite runs against both: the
 * real Node `fs` bridge on a temp directory, and the in-memory fake. Everything a test does to "play iCloud"
 * (another device writing, an eviction, a download finishing) goes through here.
 */
export interface IcloudHarness {
  kind: "node" | "fake";
  bridge: IcloudContainerBridge;
  /** Default remote folder used by `put`/`text`/... when a test does not name one. */
  folder: string;
  /** Write a file as another device would, adding the Geode marker first (content arrives with its marker). */
  put(rel: string, content: string, folder?: string): void;
  /** Write a file with no marker side effect. */
  putRaw(rel: string, content: string, folder?: string): void;
  /** Make `rel` an evicted (not-downloaded) item. */
  evict(rel: string, folder?: string): void;
  /** Replace an evicted item with real content, as a finished iCloud download does. */
  materialise(rel: string, content: string, folder?: string): void;
  mkdirRaw(rel: string, folder?: string): void;
  rm(rel: string, folder?: string): void;
  text(rel: string, folder?: string): string | null;
  exists(rel: string, folder?: string): boolean;
  /** Names directly inside `rel` (hidden ones included). */
  names(rel?: string, folder?: string): string[];
  /** Folders directly under the container's Documents/. */
  roots(): string[];
  /** Called whenever the provider asks iCloud to download something. */
  onDownload(handler: (folder: string, rel: string) => void): void;
  downloads: string[];
  makeUnavailable(): void;
  cleanup(): void;
}

const MARKER = ".geode-sync/marker.json";

export function createNodeHarness(): IcloudHarness & { documents: string } {
  const documents = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-documents-"));
  let handler: (folder: string, rel: string) => void = () => {};
  const downloads: string[] = [];
  const bridge = new NodeIcloudContainer({
    // The override env is how E2E points the real code at a temp container; the unit suite uses the same seam.
    locate: createContainerLocator({ env: { GEODE_ICLOUD_BASE: documents } }),
    platform: "darwin",
    runner: async (_command, args) => {
      const [folder, ...rest] = path.relative(documents, args[1]).split(path.sep);
      const rel = rest.join("/");
      downloads.push(rel);
      handler(folder, rel);
      return { code: 0, stderr: "" };
    },
  });
  const harness = {
    kind: "node" as const,
    bridge,
    documents,
    folder: "vault-1",
    downloads,
    abs: (rel: string, folder = "vault-1") => path.join(documents, folder, ...rel.split("/").filter(Boolean)),
  };
  const abs = harness.abs;
  const write = (rel: string, content: string, folder = harness.folder) => {
    fs.mkdirSync(path.dirname(abs(rel, folder)), { recursive: true });
    fs.writeFileSync(abs(rel, folder), content);
  };
  return Object.assign(harness, {
    putRaw: write,
    put(rel: string, content: string, folder = harness.folder) {
      if (!fs.existsSync(abs(MARKER, folder))) write(MARKER, "{}", folder);
      write(rel, content, folder);
    },
    evict(rel: string, folder = harness.folder) {
      fs.rmSync(abs(rel, folder), { force: true });
      write(path.posix.join(path.posix.dirname(rel), `.${path.posix.basename(rel)}.icloud`).replace(/^\.\//, ""), "plist", folder);
    },
    materialise(rel: string, content: string, folder = harness.folder) {
      write(rel, content, folder);
      fs.rmSync(abs(path.posix.join(path.posix.dirname(rel), `.${path.posix.basename(rel)}.icloud`).replace(/^\.\//, ""), folder), { force: true });
    },
    mkdirRaw: (rel: string, folder = harness.folder) => void fs.mkdirSync(abs(rel, folder), { recursive: true }),
    rm: (rel: string, folder = harness.folder) => void fs.rmSync(abs(rel, folder), { recursive: true, force: true }),
    text: (rel: string, folder = harness.folder) => (fs.existsSync(abs(rel, folder)) ? fs.readFileSync(abs(rel, folder), "utf8") : null),
    exists: (rel: string, folder = harness.folder) => fs.existsSync(abs(rel, folder)),
    names: (rel = "", folder = harness.folder) => (fs.existsSync(abs(rel, folder)) ? fs.readdirSync(abs(rel, folder)).sort() : []),
    roots: () => fs.readdirSync(documents).sort(),
    onDownload: (fn: (folder: string, rel: string) => void) => void (handler = fn),
    makeUnavailable: () => fs.rmSync(documents, { recursive: true, force: true }),
    cleanup: () => fs.rmSync(documents, { recursive: true, force: true }),
  });
}

export function createFakeHarness(): IcloudHarness & { fake: FakeIcloudBridge } {
  const fake = new FakeIcloudBridge();
  const downloads: string[] = [];
  const harness = { kind: "fake" as const, bridge: fake, fake, folder: "vault-1", downloads };
  fake.onDownload = (folder, rel) => void downloads.push(rel);
  return Object.assign(harness, {
    putRaw: (rel: string, content: string, folder = harness.folder) => fake.seedFile(folder, rel, content),
    put(rel: string, content: string, folder = harness.folder) {
      if (!fake.nodes.has(`${folder}/${MARKER}`)) fake.seedFile(folder, MARKER, "{}");
      fake.seedFile(folder, rel, content);
    },
    evict: (rel: string, folder = harness.folder) => fake.seedFile(folder, rel, "", { evicted: true }),
    materialise: (rel: string, content: string, folder = harness.folder) => fake.seedFile(folder, rel, content),
    mkdirRaw: (rel: string, folder = harness.folder) => fake.seedFolder(folder, rel),
    rm: (rel: string, folder = harness.folder) => fake.remove(folder, rel),
    text: (rel: string, folder = harness.folder) => fake.text(folder, rel),
    exists: (rel: string, folder = harness.folder) => fake.nodes.has(rel ? `${folder}/${rel}` : folder),
    names: (rel = "", folder = harness.folder) => fake.children(folder, rel),
    roots: () => [...fake.nodes.keys()].filter((k) => !k.includes("/")).sort(),
    onDownload(fn: (folder: string, rel: string) => void) {
      fake.onDownload = (folder, rel) => {
        downloads.push(rel);
        fn(folder, rel);
      };
    },
    makeUnavailable() {
      fake.availabilityState = { state: "unavailable", reason: "container-not-found", message: "no container" };
    },
    cleanup() {},
  });
}

import type { MetadataFileStat } from "../indexer/metadata-indexer";

interface UtilityChild {
  postMessage(message: unknown): void;
  kill(): boolean | void;
  on(event: "message", listener: (message: any) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
}

export class MetadataIndexerHost {
  private ready: Promise<true | null> | null = null;
  private resolveReady: ((available: true | null) => void) | null = null;
  private exited = false;
  private resolveShutdown: ((graceful: boolean) => void) | null = null;

  constructor(
    private readonly child: UtilityChild,
    private readonly forward: (message: unknown) => void,
  ) {
    child.on("message", (message) => {
      if (message?.type === "snapshot-complete" && this.resolveReady) {
        this.forward(message);
        this.resolveReady(true);
        this.resolveReady = null;
      } else if (message?.type === "error" && message.fatal && this.resolveReady) {
        this.resolveReady(null);
        this.resolveReady = null;
        this.forward({ type: "unavailable" });
      } else if (message?.type === "shutdown-complete") {
        this.resolveShutdown?.(true);
        this.resolveShutdown = null;
      } else {
        this.forward(message);
      }
    });
    child.on("exit", () => {
      this.exited = true;
      this.resolveReady?.(null);
      this.resolveReady = null;
      this.resolveShutdown?.(true);
      this.resolveShutdown = null;
      this.forward({ type: "unavailable" });
    });
  }

  /**
   * `scanCapBytes` is the per-vault metadata scan cap (see
   * `resolveMetadataScanCapBytes` in `../indexer/metadata-indexer`),
   * resolved by the caller from that vault's `.geode/app.json` before this
   * is called. Threaded once at initialize() time, alongside the file list
   * — like `root` and `files`, it's fixed for the lifetime of this utility
   * process; a setting change while the vault is open takes effect for the
   * renderer's own parsing immediately (see `MetadataCache.setScanCapBytes`)
   * but only reaches the background indexer the next time the vault is
   * (re)opened, which restarts this utility process.
   */
  initialize(root: string, files: MetadataFileStat[], scanCapBytes?: number): Promise<true | null> {
    if (!this.ready) {
      this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
      this.child.postMessage({ type: "initialize", root, files, scanCapBytes });
    }
    return this.ready;
  }

  postVaultEvent(event: "create" | "modify" | "delete", path: string): void {
    if (!this.exited) this.child.postMessage({ type: "vault-event", event, path });
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    this.child.postMessage({ type: "shutdown" });
    let timeout: ReturnType<typeof setTimeout>;
    const graceful = await Promise.race([
      new Promise<boolean>((resolve) => { this.resolveShutdown = resolve; }),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 5_000); }),
    ]);
    clearTimeout(timeout!);
    if (!graceful && !this.exited) this.child.kill();
  }
}

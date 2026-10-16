import * as fs from "node:fs";
import * as path from "node:path";
import { expect, type ElementHandle, type Locator, type Page, type TestInfo } from "@playwright/test";

interface Background {
  node: ElementHandle<SVGElement | HTMLElement>;
  url: string;
  kind: "image" | "audio";
  media?: ElementHandle<SVGElement | HTMLElement>;
}

/** Observe real browser URL operations; every wrapper calls the native operation. */
export class CanvasBackgroundLifetimes {
  private readonly expectedRevokedProbes = new Set<string>();

  private readonly evidence: unknown[] = [];
  private readonly kinds = new Map<string, "image" | "audio">();

  constructor(private readonly page: Page, private readonly key: string, private readonly info: TestInfo) {}

  private async record(kind: string, details: Record<string, unknown> = {}): Promise<void> {
    this.evidence.push({ kind, ...details, tracker: await this.tracker() });
    const destination = this.info.outputPath("background-resources.json");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(this.evidence, null, 2));
    if (kind === "all-created-revoked-once-decode-rejected") {
      await this.info.attach(`background-resources-${this.evidence.length}`, { path: destination, contentType: "application/json" });
    }
  }

  async install(): Promise<void> {
    await this.page.evaluate((key) => {
      const created: string[] = [];
      const revoked: string[] = [];
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob: Blob) => {
        const url = create(blob);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url: string) => { revoked.push(url); revoke(url); };
      (window as any)[key] = { created, revoked };
    }, this.key);
    await this.record("tracker-installed");
  }

  /** Only a deliberately failed native resource request may be excluded. */
  isExpectedProbeError(text: string, locationUrl: string): boolean {
    return this.expectedRevokedProbes.has(locationUrl)
      && /^Failed to load resource: net::ERR_/.test(text);
  }

  isExpectedProbeRequestFailure(url: string): boolean {
    return this.expectedRevokedProbes.has(url);
  }

  async tracker(): Promise<{ created: string[]; revoked: string[] }> {
    return this.page.evaluate((key) => {
      const state = (window as any)[key];
      return { created: [...state.created], revoked: [...state.revoked] };
    }, this.key);
  }

  async capture(scope: Locator, id: string): Promise<Background> {
    const locator = scope.locator(`.canvas-node[data-node-id="${id}"]`);
    await expect(locator).toHaveCSS("background-image", /^url\("blob:/);
    const node = await locator.elementHandle();
    if (!node) throw new Error(`Missing background presentation: ${id}`);
    const css = await locator.evaluate((el) => getComputedStyle(el).backgroundImage);
    const match = /^url\("(blob:[^"]+)"\)$/.exec(css);
    if (!match) throw new Error(`Unexpected background URL: ${css}`);
    const background: Background = { node, url: match[1], kind: "image" };
    this.kinds.set(background.url, background.kind);
    expect(await node.evaluate((el) => el.isConnected)).toBe(true);
    const native = await this.expectDecodable(background.url, background.kind);
    await this.record("connected-decoded", { id, url: background.url, native });
    return background;
  }

  async captureMedia(scope: Locator, id: string, kind: "image" | "audio"): Promise<Background> {
    const locator = scope.locator(`.canvas-node[data-node-id="${id}"]`);
    const mediaLocator = locator.locator(kind === "image" ? "img.canvas-node-media" : "audio.canvas-node-media");
    await expect(mediaLocator).toHaveAttribute("src", /^blob:/);
    const node = await locator.elementHandle();
    const media = await mediaLocator.elementHandle();
    if (!node || !media) throw new Error(`Missing media presentation: ${id}`);
    const url = await mediaLocator.evaluate((el) => (el as HTMLImageElement | HTMLMediaElement).src);
    this.kinds.set(url, kind);
    expect(await node.evaluate((el) => el.isConnected)).toBe(true);
    expect(await media.evaluate((el) => el.isConnected)).toBe(true);
    const native = await this.expectDecodable(url, kind);
    await this.record("connected-native-media-decoded", { id, url, kind, native });
    return { node, media, url, kind };
  }

  async expectRetained(scope: Locator, id: string, previous: Background): Promise<void> {
    expect(await previous.node.evaluate((el) => el.isConnected)).toBe(true);
    expect(await scope.locator(`.canvas-node[data-node-id="${id}"]`)
      .evaluate((el, old) => el === old, previous.node)).toBe(true);
    const current = previous.media
      ? await this.captureMedia(scope, id, previous.kind)
      : await this.capture(scope, id);
    if (previous.media) {
      const selector = previous.kind === "image" ? "img.canvas-node-media" : "audio.canvas-node-media";
      expect(await scope.locator(`.canvas-node[data-node-id="${id}"]`).locator(selector)
        .evaluate((el, old) => el === old, previous.media)).toBe(true);
    }
    expect(current.url).toBe(previous.url);
    expect((await this.tracker()).revoked.filter((url) => url === previous.url)).toHaveLength(0);
    await this.record("same-node-and-url-retained", { id, url: previous.url });
  }

  async expectLiveExactly(backgrounds: Background[]): Promise<void> {
    const state = await this.tracker();
    expect(state.created.filter((url) => !state.revoked.includes(url)).sort())
      .toEqual(backgrounds.map(({ url }) => url).sort());
  }

  async expectRetired(backgrounds: Background[]): Promise<void> {
    for (const { node, url, kind, media } of backgrounds) {
      await expect.poll(async () => (await this.tracker()).revoked.filter((value) => value === url).length).toBe(1);
      expect(await node.evaluate((el) => el.isConnected)).toBe(false);
      if (media) expect(await media.evaluate((el) => el.isConnected)).toBe(false);
      this.expectedRevokedProbes.add(url);
      expect(await this.decode(url, kind), `A fresh native ${kind} must reject retired ${url}`).toEqual({ decoded: false });
      await this.record("disconnected-revoked-once-decode-rejected", { url });
    }
  }

  async expectAllRetired(): Promise<void> {
    await expect.poll(async () => {
      const current = await this.tracker();
      return current.created.every((url) => current.revoked.filter((value) => value === url).length === 1);
    }).toBe(true);
    const state = await this.tracker();
    for (const url of state.created) {
      this.expectedRevokedProbes.add(url);
      const kind = this.kinds.get(url);
      if (!kind) throw new Error(`Created URL never received a positive resource proof: ${url}`);
      expect(await this.decode(url, kind)).toEqual({ decoded: false });
    }
    await this.expectLiveExactly([]);
    await this.record("all-created-revoked-once-decode-rejected");
  }

  private async expectDecodable(url: string, kind: "image" | "audio"): Promise<{
    decoded: boolean; width?: number; height?: number; duration?: number;
  }> {
    const result = await this.decode(url, kind);
    if (kind === "image") expect(result).toEqual({ decoded: true, width: 1, height: 1 });
    else {
      expect(result.decoded).toBe(true);
      expect(result.duration).toBeGreaterThan(0);
      expect(Number.isFinite(result.duration)).toBe(true);
    }
    return result;
  }

  private decode(url: string, kind: "image" | "audio"): Promise<{
    decoded: boolean; width?: number; height?: number; duration?: number;
  }> {
    return this.page.evaluate(async ({ source, kind }) => {
      if (kind === "audio") {
        const audio = document.createElement("audio");
        audio.preload = "auto";
        return new Promise<{ decoded: boolean; duration?: number }>((resolve, reject) => {
          let settled = false;
          const finish = (result: { decoded: boolean; duration?: number }, failure?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            audio.onloadeddata = null;
            audio.onerror = null;
            audio.removeAttribute("src");
            audio.load();
            if (failure) reject(failure);
            else resolve(result);
          };
          const timeout = setTimeout(() => finish(
            { decoded: false }, new Error("Native audio resource probe timed out"),
          ), 2000);
          audio.onloadeddata = () => finish({ decoded: true, duration: audio.duration });
          audio.onerror = () => finish({ decoded: false });
          audio.src = source;
          audio.load();
        });
      }
      const image = new Image();
      image.src = source;
      try {
        await image.decode();
        return { decoded: true, width: image.naturalWidth, height: image.naturalHeight };
      } catch {
        return { decoded: false };
      } finally {
        image.removeAttribute("src");
      }
    }, { source: url, kind });
  }
}

/** A real close must be persisted before a renderer reload resets URL tracking. */
export async function expectSavedCanvasClosure(vaultDir: string): Promise<void> {
  await expect.poll(() => {
    try {
      const layout = JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "workspace.json"), "utf8"));
      return !!layout.center && !JSON.stringify(layout.center).includes('"type":"canvas"');
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }).toBe(true);
}

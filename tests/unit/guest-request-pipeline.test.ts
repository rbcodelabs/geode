import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { attachGuestRequestPipeline, type HeaderStage } from "../../src/main/guest-request-pipeline";

/**
 * `session.webRequest.onBeforeSendHeaders` accepts only ONE listener per
 * session; a second registration SILENTLY REPLACES the first (no error). This
 * suite pins the property that makes `attachGuestRequestPipeline` the fix:
 * however many stages are composed, exactly one `onBeforeSendHeaders` call is
 * ever made against a given session, and stages share one mutable header set
 * rather than each getting their own registration.
 */

interface FakeSession {
  webRequest: {
    onBeforeSendHeaders: ReturnType<typeof vi.fn>;
  };
}

function fakeSession(): FakeSession {
  return { webRequest: { onBeforeSendHeaders: vi.fn() } };
}

function fakeDetails(overrides: Partial<Electron.OnBeforeSendHeadersListenerDetails> = {}) {
  return {
    id: 1,
    url: "https://example.com/",
    method: "GET",
    resourceType: "mainFrame",
    referrer: "",
    timestamp: Date.now(),
    requestHeaders: { "user-agent": "ua" },
    ...overrides,
  } as unknown as Electron.OnBeforeSendHeadersListenerDetails;
}

describe("attachGuestRequestPipeline", () => {
  it("registers nothing when there are no stages", () => {
    const session = fakeSession();
    attachGuestRequestPipeline(session as unknown as Electron.Session, []);
    expect(session.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
  });

  it("registers exactly one onBeforeSendHeaders listener regardless of stage count", () => {
    const session = fakeSession();
    const stages: HeaderStage[] = [() => false, () => false, () => false, () => false, () => false];
    attachGuestRequestPipeline(session as unknown as Electron.Session, stages);
    expect(session.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
  });

  it("filters to http(s) URLs only", () => {
    const session = fakeSession();
    attachGuestRequestPipeline(session as unknown as Electron.Session, [() => false]);
    expect(session.webRequest.onBeforeSendHeaders.mock.calls[0][0]).toEqual({
      urls: ["http://*/*", "https://*/*"],
    });
  });

  it("runs stages in order over one shared, mutable header set", () => {
    const session = fakeSession();
    const order: string[] = [];
    const stages: HeaderStage[] = [
      (ctx) => {
        order.push("a");
        ctx.headers["x-a"] = "1";
        return true;
      },
      (ctx) => {
        order.push("b");
        // Sees what the earlier stage already added.
        expect(ctx.headers["x-a"]).toBe("1");
        ctx.headers["x-b"] = "2";
        return true;
      },
    ];
    attachGuestRequestPipeline(session as unknown as Electron.Session, stages);
    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][1];
    const callback = vi.fn();

    listener(fakeDetails(), callback);

    expect(order).toEqual(["a", "b"]);
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { "user-agent": "ua", "x-a": "1", "x-b": "2" },
    });
  });

  it("leaves the request untouched (callback({})) when no stage reports a change", () => {
    const session = fakeSession();
    attachGuestRequestPipeline(session as unknown as Electron.Session, [() => false, () => false]);
    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][1];
    const callback = vi.fn();

    listener(fakeDetails(), callback);

    expect(callback).toHaveBeenCalledWith({});
  });

  it("rewrites headers if ANY stage reports a change, even if a later stage does not", () => {
    const session = fakeSession();
    const stages: HeaderStage[] = [
      (ctx) => {
        ctx.headers["x-a"] = "1";
        return true;
      },
      () => false,
    ];
    attachGuestRequestPipeline(session as unknown as Electron.Session, stages);
    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][1];
    const callback = vi.fn();

    listener(fakeDetails(), callback);

    expect(callback).toHaveBeenCalledWith({ requestHeaders: { "user-agent": "ua", "x-a": "1" } });
  });

  it("does not mutate details.requestHeaders directly (headers is a copy)", () => {
    const session = fakeSession();
    attachGuestRequestPipeline(session as unknown as Electron.Session, [
      (ctx) => {
        ctx.headers["x-a"] = "1";
        return true;
      },
    ]);
    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][1];
    const details = fakeDetails();
    listener(details, vi.fn());

    expect(details.requestHeaders).toEqual({ "user-agent": "ua" });
  });

  it("exposes each stage the request's details alongside the shared headers", () => {
    const session = fakeSession();
    let seenUrl: string | undefined;
    let seenResourceType: string | undefined;
    attachGuestRequestPipeline(session as unknown as Electron.Session, [
      (ctx) => {
        seenUrl = ctx.details.url;
        seenResourceType = ctx.details.resourceType;
        return false;
      },
    ]);
    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][1];
    listener(fakeDetails({ url: "https://a.example/x", resourceType: "xhr" as never }), vi.fn());

    expect(seenUrl).toBe("https://a.example/x");
    expect(seenResourceType).toBe("xhr");
  });
});

/**
 * Static guard for the footgun this module exists to close: nothing outside
 * `guest-request-pipeline.ts` may call `webRequest.onBeforeSendHeaders`
 * directly, because a second call site on the same session would silently
 * disable whichever one registered first. If a future change adds a second
 * direct registration, this test fails loudly instead of letting requests
 * silently lose whichever stage got clobbered.
 */
/** Strip `/* ... *\/` and `// ...` comments so prose mentioning the call pattern doesn't trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("onBeforeSendHeaders registration site", () => {
  it("is registered only inside guest-request-pipeline.ts", () => {
    const srcMainDir = path.resolve(__dirname, "..", "..", "src", "main");
    const offenders: string[] = [];

    for (const file of fs.readdirSync(srcMainDir)) {
      if (!file.endsWith(".ts") || file === "guest-request-pipeline.ts") continue;
      const code = stripComments(fs.readFileSync(path.join(srcMainDir, file), "utf8"));
      if (/webRequest\.onBeforeSendHeaders\s*\(/.test(code)) offenders.push(file);
    }

    expect(offenders, `found a second onBeforeSendHeaders registration in: ${offenders.join(", ")}`).toEqual([]);
  });
});

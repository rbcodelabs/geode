import { describe, expect, it } from "vitest";
import {
  normalizeWebViewerEvent,
  resolveWebViewerConnector,
  WEB_VIEWER_CONNECTORS,
  WEBVIEWER_BRIDGE_CHANNEL,
  type WebViewerBridgeMessage,
} from "../../src/shared/web-viewer-connectors";

const COMPASS_URL = "https://compass.rbcodelabs.com/rbcodelabs/geode";

describe("WEBVIEWER_BRIDGE_CHANNEL", () => {
  it("is a stable shared constant", () => {
    expect(WEBVIEWER_BRIDGE_CHANNEL).toBe("webviewer-bridge-event");
  });
});

describe("resolveWebViewerConnector", () => {
  it("matches on exact hostname", () => {
    const connector = resolveWebViewerConnector(COMPASS_URL);
    expect(connector).toEqual(WEB_VIEWER_CONNECTORS[0]);
  });

  it("rejects a subdomain confusable", () => {
    expect(resolveWebViewerConnector("https://evilcompass.rbcodelabs.com/")).toBeNull();
  });

  it("rejects a suffix confusable", () => {
    expect(resolveWebViewerConnector("https://compass.rbcodelabs.com.evil.com/")).toBeNull();
  });

  it("rejects a prefix confusable with a dot", () => {
    expect(resolveWebViewerConnector("https://sub.compass.rbcodelabs.com/")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(resolveWebViewerConnector("not a url")).toBeNull();
  });

  it("returns null for an unrelated origin", () => {
    expect(resolveWebViewerConnector("https://example.com/")).toBeNull();
  });
});

describe("normalizeWebViewerEvent", () => {
  const validMessage: WebViewerBridgeMessage = {
    type: "decision.approved",
    payload: { decisionId: "test-1" },
  };

  it("drops a disallowed event type from an otherwise valid origin", () => {
    const message: WebViewerBridgeMessage = { type: "not.allowed", payload: {} };
    expect(normalizeWebViewerEvent(COMPASS_URL, message)).toBeNull();
  });

  it("drops a valid event type from a non-connector origin", () => {
    expect(normalizeWebViewerEvent("https://example.com/", validMessage)).toBeNull();
  });

  it("drops a non-string type", () => {
    const message = { type: 42, payload: {} } as unknown as WebViewerBridgeMessage;
    expect(normalizeWebViewerEvent(COMPASS_URL, message)).toBeNull();
  });

  it("drops an oversized payload", () => {
    const message: WebViewerBridgeMessage = {
      type: "decision.approved",
      payload: { blob: "x".repeat(8200) },
    };
    expect(normalizeWebViewerEvent(COMPASS_URL, message)).toBeNull();
  });

  it("accepts a payload right at the 8192-char serialized boundary", () => {
    // {"decisionId":"..."} — pad decisionId so the whole JSON string is exactly 8192 chars.
    const prefix = '{"decisionId":"';
    const suffix = '"}';
    const padLength = 8192 - prefix.length - suffix.length;
    const message: WebViewerBridgeMessage = {
      type: "decision.approved",
      payload: { decisionId: "x".repeat(padLength) },
    };
    expect(JSON.stringify(message.payload).length).toBe(8192);
    expect(normalizeWebViewerEvent(COMPASS_URL, message)).not.toBeNull();
  });

  it("drops a non-JSON-serializable payload (function)", () => {
    const message = { type: "decision.approved", payload: { fn: () => {} } } as unknown as WebViewerBridgeMessage;
    expect(normalizeWebViewerEvent(COMPASS_URL, message)).toBeNull();
  });

  it("drops a non-JSON-serializable payload (circular reference)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const message = { type: "decision.approved", payload: circular } as unknown as WebViewerBridgeMessage;
    expect(normalizeWebViewerEvent(COMPASS_URL, message)).toBeNull();
  });

  it("normalizes an omitted (undefined) payload to null instead of dropping the event", () => {
    const message = { type: "decision.approved", payload: undefined } as unknown as WebViewerBridgeMessage;
    const result = normalizeWebViewerEvent(COMPASS_URL, message);
    expect(result).not.toBeNull();
    expect(result?.payload).toBeNull();
  });

  it("returns the exact expected normalized shape on success", () => {
    const before = Date.now();
    const result = normalizeWebViewerEvent(COMPASS_URL, validMessage);
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result?.source).toBe("compass");
    expect(result?.type).toBe("decision.approved");
    expect(result?.payload).toEqual({ decisionId: "test-1" });
    expect(result?.url).toBe(COMPASS_URL);
    expect(typeof result?.timestamp).toBe("number");
    expect(result?.timestamp).toBeGreaterThanOrEqual(before);
    expect(result?.timestamp).toBeLessThanOrEqual(after);
    expect(Object.keys(result ?? {}).sort()).toEqual(["payload", "source", "timestamp", "type", "url"]);
  });
});

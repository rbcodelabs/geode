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

/**
 * `agent.handoff` — Compass's "Send to Agent → Geode" handoff (Compass Task
 * 53a982f2, Solution 17be677b, piece 2 of 3). Compass posts this via
 * `window.__geode.postEvent`; Agent Threads consumes it off the
 * `web-viewer:event` bus. Geode core's only job is to permit the type.
 */
describe("agent.handoff connector allowlisting", () => {
  const handoffMessage: WebViewerBridgeMessage = {
    type: "agent.handoff",
    payload: {
      entityType: "solutionPlan",
      entityId: "plan-1",
      orgSlug: "rbcodelabs",
      workspaceSlug: "geode",
      instruction: "Review this approved plan and identify delivery risks.",
      url: "https://compass.rbcodelabs.com/rbcodelabs/geode/discovery",
      title: "Send to Agent → Geode",
    },
  };

  it("accepts agent.handoff from the Compass origin", () => {
    const result = normalizeWebViewerEvent(COMPASS_URL, handoffMessage);
    expect(result).not.toBeNull();
    expect(result?.source).toBe("compass");
    expect(result?.type).toBe("agent.handoff");
    expect(result?.payload).toEqual(handoffMessage.payload);
  });

  it("still rejects an unlisted type from the SAME (Compass) origin", () => {
    // The guard that matters: proves adding agent.handoff widened the allowlist
    // by exactly one entry rather than turning it into a pass-through.
    for (const type of ["agent.handoff.evil", "agent", "*", "arbitrary.type"]) {
      expect(normalizeWebViewerEvent(COMPASS_URL, { type, payload: {} })).toBeNull();
    }
  });

  it("rejects agent.handoff from a non-connector origin", () => {
    // NOTE: before agent.handoff was allowlisted this passed vacuously (the
    // type was rejected outright). Post-change it exercises the origin check
    // for real, which is the point of keeping it.
    expect(normalizeWebViewerEvent("https://example.com/", handoffMessage)).toBeNull();
    expect(normalizeWebViewerEvent("https://evilcompass.rbcodelabs.com/", handoffMessage)).toBeNull();
    expect(normalizeWebViewerEvent("https://compass.rbcodelabs.com.evil.com/", handoffMessage)).toBeNull();
  });

  it("grants agent.handoff to the compass connector and to no other connector", () => {
    // Pins the full registry shape so a future connector can't silently
    // inherit agent-instruction traffic.
    for (const connector of WEB_VIEWER_CONNECTORS) {
      if (connector.id === "compass") {
        expect([...connector.allowedEventTypes].sort()).toEqual(["agent.handoff", "decision.approved"]);
      } else {
        expect(connector.allowedEventTypes).not.toContain("agent.handoff");
      }
    }
  });
});

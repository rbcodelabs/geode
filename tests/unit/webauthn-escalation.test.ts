import { describe, expect, it } from "vitest";
import {
  normalizeWebAuthnEscalationSignal,
  WEBAUTHN_ESCALATION_CHANNEL,
  type WebAuthnEscalationMessage,
} from "../../src/shared/webauthn-escalation";

const RP_URL = "https://example-identity-provider.test/login";

describe("WEBAUTHN_ESCALATION_CHANNEL", () => {
  it("is a stable shared constant, distinct from the connector bridge channel", () => {
    expect(WEBAUTHN_ESCALATION_CHANNEL).toBe("webauthn-escalation-signal");
  });
});

describe("normalizeWebAuthnEscalationSignal", () => {
  const validMessage: WebAuthnEscalationMessage = {
    ceremony: "create",
    errorName: "SecurityError",
    errorMessage: "The following credential types are not enabled in this context: publickey.",
  };

  it("accepts a well-formed signal from any origin (unrestricted, unlike the connector bridge)", () => {
    const result = normalizeWebAuthnEscalationSignal(RP_URL, validMessage);
    expect(result).not.toBeNull();
    expect(result?.ceremony).toBe("create");
    expect(result?.errorName).toBe("SecurityError");
    expect(result?.errorMessage).toBe(validMessage.errorMessage);
    expect(result?.url).toBe(RP_URL);
    expect(typeof result?.timestamp).toBe("number");
  });

  it("accepts the get ceremony kind too", () => {
    const result = normalizeWebAuthnEscalationSignal(RP_URL, { ...validMessage, ceremony: "get" });
    expect(result?.ceremony).toBe("get");
  });

  it("rejects an unknown ceremony kind", () => {
    const message = { ...validMessage, ceremony: "delete" } as unknown as WebAuthnEscalationMessage;
    expect(normalizeWebAuthnEscalationSignal(RP_URL, message)).toBeNull();
  });

  it("rejects a non-string errorName", () => {
    const message = { ...validMessage, errorName: 42 } as unknown as WebAuthnEscalationMessage;
    expect(normalizeWebAuthnEscalationSignal(RP_URL, message)).toBeNull();
  });

  it("rejects a non-string errorMessage", () => {
    const message = { ...validMessage, errorMessage: null } as unknown as WebAuthnEscalationMessage;
    expect(normalizeWebAuthnEscalationSignal(RP_URL, message)).toBeNull();
  });

  it("rejects an oversized errorMessage", () => {
    const message = { ...validMessage, errorMessage: "x".repeat(5000) };
    expect(normalizeWebAuthnEscalationSignal(RP_URL, message)).toBeNull();
  });

  it("rejects a malformed frame URL", () => {
    expect(normalizeWebAuthnEscalationSignal("not a url", validMessage)).toBeNull();
  });

  it("rejects a non-http(s) frame URL", () => {
    expect(normalizeWebAuthnEscalationSignal("file:///etc/passwd", validMessage)).toBeNull();
  });

  it("rejects a null message", () => {
    expect(normalizeWebAuthnEscalationSignal(RP_URL, null)).toBeNull();
  });

  it("rejects a non-object message", () => {
    expect(normalizeWebAuthnEscalationSignal(RP_URL, "webauthn.rejected")).toBeNull();
  });

  it("returns the exact expected normalized shape on success", () => {
    const before = Date.now();
    const result = normalizeWebAuthnEscalationSignal(RP_URL, validMessage);
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result?.timestamp).toBeGreaterThanOrEqual(before);
    expect(result?.timestamp).toBeLessThanOrEqual(after);
    expect(Object.keys(result ?? {}).sort()).toEqual(
      ["ceremony", "errorMessage", "errorName", "timestamp", "url"]
    );
  });
});

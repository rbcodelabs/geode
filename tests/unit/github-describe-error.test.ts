import { describe, expect, it } from "vitest";
import { describeNetworkError } from "../../src/main/github-auth";

describe("describeNetworkError", () => {
  it("appends the cause code and host that undici hides behind 'fetch failed'", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND", hostname: "api.github.com" });
    expect(describeNetworkError(new TypeError("fetch failed", { cause }))).toBe("fetch failed (ENOTFOUND api.github.com)");
  });

  it("uses a code on its own when there is no hostname", () => {
    expect(describeNetworkError(new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } }))).toBe("fetch failed (ETIMEDOUT)");
  });

  it("walks nested causes and falls back to messages", () => {
    const inner = Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    const mid = new Error("TLS handshake failed", { cause: inner });
    expect(describeNetworkError(new TypeError("fetch failed", { cause: mid }))).toBe(
      "fetch failed (TLS handshake failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
    );
  });

  it("does not repeat a cause that matches the message, and survives cycles", () => {
    const a: Error & { cause?: unknown } = new Error("boom");
    a.cause = a;
    expect(describeNetworkError(a)).toBe("boom");
  });

  it("handles errors without a cause and non-Error values", () => {
    expect(describeNetworkError(new Error("plain"))).toBe("plain");
    expect(describeNetworkError("just text")).toBe("just text");
    expect(describeNetworkError(undefined)).toBe("undefined");
    expect(describeNetworkError({ code: 1 })).toBe("[object Object]");
  });
});

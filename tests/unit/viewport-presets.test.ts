import { describe, expect, it } from "vitest";
import {
  VIEWPORTS,
  VIEWPORT_CONTROLS,
  VIEWPORT_PRESET_ORDER,
  isLoopbackOrigin,
  normalizeViewport,
} from "../../src/renderer/views/viewport-presets";

describe("VIEWPORTS and VIEWPORT_CONTROLS", () => {
  it("exposes Fill, Desktop 1440×900, Tablet 768×1024, and Mobile 390×844", () => {
    expect(VIEWPORT_PRESET_ORDER).toEqual(["fill", "desktop", "tablet", "mobile"]);
    expect(VIEWPORTS.fill).toEqual({ preset: "fill", width: 1440, height: 900 });
    expect(VIEWPORTS.desktop).toEqual({ preset: "desktop", width: 1440, height: 900 });
    expect(VIEWPORTS.tablet).toEqual({ preset: "tablet", width: 768, height: 1024 });
    expect(VIEWPORTS.mobile).toEqual({ preset: "mobile", width: 390, height: 844 });
    expect(VIEWPORT_CONTROLS).toEqual({
      fill: { icon: "maximize-2", label: "Fill pane" },
      desktop: { icon: "monitor", label: "Desktop" },
      tablet: { icon: "tablet", label: "Tablet" },
      mobile: { icon: "smartphone", label: "Mobile" },
    });
  });

  it("normalizes persisted viewport state safely", () => {
    expect(normalizeViewport(undefined)).toEqual(VIEWPORTS.fill);
    expect(normalizeViewport(null)).toEqual(VIEWPORTS.fill);
    expect(normalizeViewport("mobile")).toEqual(VIEWPORTS.fill);
    expect(normalizeViewport({ preset: "mobile", width: 1, height: 1 })).toEqual(VIEWPORTS.mobile);
    expect(normalizeViewport({ preset: "tablet" })).toEqual(VIEWPORTS.tablet);
    expect(normalizeViewport({ preset: "desktop" })).toEqual(VIEWPORTS.desktop);
    expect(normalizeViewport({ preset: "custom", width: 1024.4, height: 768.6 })).toEqual({
      preset: "custom",
      width: 1024,
      height: 769,
    });
    expect(normalizeViewport({ preset: "custom", width: -10, height: 500 })).toEqual(VIEWPORTS.fill);
    expect(normalizeViewport({ preset: "custom", width: Number.NaN, height: 500 })).toEqual(VIEWPORTS.fill);
    expect(normalizeViewport({ preset: "custom", width: 50_000, height: 500 })).toEqual(VIEWPORTS.fill);
  });
});

describe("isLoopbackOrigin", () => {
  it("recognizes localhost, 127.0.0.1, [::1], and ::1 over HTTP/HTTPS or bare hostnames", () => {
    expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLoopbackOrigin("https://LOCALHOST:8443/app")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isLoopbackOrigin("https://127.0.0.1/path?x=1")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:8080")).toBe(true);
    expect(isLoopbackOrigin("http://[0:0:0:0:0:0:0:1]:8080")).toBe(true);
    expect(isLoopbackOrigin("localhost")).toBe(true);
    expect(isLoopbackOrigin("127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("[::1]")).toBe(true);
    expect(isLoopbackOrigin("::1")).toBe(true);
  });

  it("returns false for external domains, lookalike subdomains, non-HTTP schemes, and invalid input", () => {
    expect(isLoopbackOrigin("https://preview.vercel.app")).toBe(false);
    expect(isLoopbackOrigin("http://localhost.evil.com:3000")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.1.nip.io")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.2:3000")).toBe(false);
    expect(isLoopbackOrigin("http://192.168.1.10:3000")).toBe(false);
    expect(isLoopbackOrigin("file:///Users/demo/index.html")).toBe(false);
    expect(isLoopbackOrigin("ftp://localhost")).toBe(false);
    expect(isLoopbackOrigin("javascript:alert(1)")).toBe(false);
    expect(isLoopbackOrigin("about:blank")).toBe(false);
    expect(isLoopbackOrigin("null")).toBe(false);
    expect(isLoopbackOrigin("")).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManifest, parseOnboardingSection } from "../../src/renderer/plugin-manifest";

const base = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "d",
  author: "a",
};

afterEach(() => vi.restoreAllMocks());

describe("manifest onboarding field", () => {
  it("is absent from the parsed manifest when not declared", () => {
    expect(parseManifest(JSON.stringify(base))).not.toHaveProperty("onboarding");
  });

  it("parses valid steps", () => {
    const m = parseManifest(
      JSON.stringify({
        ...base,
        onboarding: {
          steps: [
            { id: "connect", title: " Connect ", description: "d", group: "Setup", commandId: "acme:connect", optional: true },
            { id: "second", title: "Second" },
          ],
        },
      })
    );
    expect(m.onboarding?.steps).toEqual([
      { id: "connect", title: "Connect", description: "d", group: "Setup", commandId: "acme:connect", optional: true },
      { id: "second", title: "Second" },
    ]);
  });

  it("ignores invalid entries with a warning and never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = parseManifest(
      JSON.stringify({
        ...base,
        onboarding: {
          steps: [
            null,
            "str",
            { title: "no id" },
            { id: "has space", title: "bad id" },
            { id: "no-title" },
            { id: "ok", title: "OK", optional: "yes", commandId: 5, group: 7 },
            { id: "ok", title: "dup" },
          ],
        },
      })
    );
    expect(m.onboarding?.steps).toEqual([{ id: "ok", title: "OK" }]);
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it.each([42, "x", [], null, {}, { steps: "no" }])("ignores a malformed section %j", (section) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => parseManifest(JSON.stringify({ ...base, onboarding: section }))).not.toThrow();
    expect(parseOnboardingSection(section, "acme")).toBeUndefined();
  });
});

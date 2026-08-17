import { describe, expect, it } from "vitest";
import { isAllowedAppNavigation } from "../../src/main/navigation-policy";

describe("isAllowedAppNavigation", () => {
  const indexUrl = "file:///Applications/Geode/resources/app/src/renderer/index.html";

  it("allows only the app's exact index URL", () => {
    expect(isAllowedAppNavigation(indexUrl, indexUrl)).toBe(true);
    expect(isAllowedAppNavigation(`${indexUrl}#reload`, indexUrl)).toBe(false);
    expect(isAllowedAppNavigation("file:///Users/rick/vault/Note.md", indexUrl)).toBe(false);
    expect(isAllowedAppNavigation("https://example.com", indexUrl)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  VAULT_AVATAR_COLORS,
  nextHubCardIndex,
  orderVaultPaths,
  vaultAvatarColor,
  vaultInitial,
  vaultNameFromPath,
} from "../../src/renderer/vault-hub-model";

describe("vault hub avatar", () => {
  it("derives the color deterministically from the name, ignoring case and surrounding space", () => {
    expect(vaultAvatarColor("Personal")).toBe(vaultAvatarColor("Personal"));
    expect(vaultAvatarColor("Personal")).toBe(vaultAvatarColor("  personal "));
    expect(VAULT_AVATAR_COLORS).toContain(vaultAvatarColor("Personal"));
  });

  it("spreads different names over the palette", () => {
    const names = ["Personal", "Geode Docs", "Hip Trip Research", "Compass Notes", "Work", "Recipes", "Journal", "Archive"];
    expect(new Set(names.map(vaultAvatarColor)).size).toBeGreaterThan(3);
  });

  it("uses the first letter or digit as the initial, by code point", () => {
    expect(vaultInitial("personal")).toBe("P");
    expect(vaultInitial("  _2024 notes")).toBe("2");
    expect(vaultInitial("日本語")).toBe("日");
    expect(vaultInitial("***")).toBe("?");
    expect(vaultInitial("")).toBe("?");
  });

  it("names a vault by its folder, or by the id when there is no path", () => {
    expect(vaultNameFromPath("/home/rick/vault")).toBe("vault");
    expect(vaultNameFromPath("C:\\Users\\rick\\Notes\\")).toBe("Notes");
    expect(vaultNameFromPath("/")).toBe("/");
  });
});

describe("vault hub ordering", () => {
  it("puts the open vault first, keeps registry order, and drops duplicates", () => {
    expect(orderVaultPaths("/b", ["/a", "/b", "/c", "/a"])).toEqual(["/b", "/a", "/c"]);
  });

  it("keeps recents untouched when no vault is open", () => {
    expect(orderVaultPaths(null, ["/a", "/b"])).toEqual(["/a", "/b"]);
    expect(orderVaultPaths(null, [])).toEqual([]);
  });

  it("includes an open vault that the registry no longer lists", () => {
    expect(orderVaultPaths("/x", ["/a"])).toEqual(["/x", "/a"]);
  });
});

describe("vault hub keyboard navigation", () => {
  // 7 cards, 3 columns: rows [0 1 2] [3 4 5] [6]
  const move = (from: number, key: Parameters<typeof nextHubCardIndex>[2]) => nextHubCardIndex(7, from, key, 3);

  it("moves by one across and by a row up and down", () => {
    expect(move(1, "ArrowRight")).toBe(2);
    expect(move(1, "ArrowLeft")).toBe(0);
    expect(move(1, "ArrowDown")).toBe(4);
    expect(move(4, "ArrowUp")).toBe(1);
  });

  it("stops at the edges instead of wrapping", () => {
    expect(move(0, "ArrowLeft")).toBe(0);
    expect(move(6, "ArrowRight")).toBe(6);
    expect(move(1, "ArrowUp")).toBe(1);
    expect(move(6, "ArrowDown")).toBe(6);
  });

  it("lands on the last card when going down into a short final row", () => {
    expect(move(4, "ArrowDown")).toBe(6);
    expect(move(5, "ArrowDown")).toBe(6);
  });

  it("supports Home and End and a single-column layout", () => {
    expect(move(4, "Home")).toBe(0);
    expect(move(4, "End")).toBe(6);
    expect(nextHubCardIndex(3, 0, "ArrowDown", 1)).toBe(1);
    expect(nextHubCardIndex(0, 0, "ArrowDown", 3)).toBe(-1);
  });
});

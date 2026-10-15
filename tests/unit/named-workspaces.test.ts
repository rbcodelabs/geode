import { describe, expect, it, vi } from "vitest";
import { NamedWorkspaces, validateNamedLayout } from "../../src/renderer/workspaces/named-workspaces";
const tabs = (file = "Note.md") => ({ type: "tabs", active: 0, leaves: [{ type: "markdown", file }] });
const layout = () => ({ version: 3, center: { root: tabs(), activeGroup: 0 }, left: { root: tabs(), collapsed: false, width: 280 }, right: { root: tabs(), collapsed: true, width: 240 } });
function setup(initial: unknown = null) {
  let stored = initial; let current = true;
  const config = { read: vi.fn(async () => stored), write: vi.fn(async (_key: string, value: unknown) => { stored = value; }) };
  const manager = new NamedWorkspaces(config, () => current);
  return { manager, config, stored: () => stored, expire: () => { current = false; } };
}
describe("named layouts storage", () => {
  it("saves, updates same trimmed name and deletes only the chosen record", async () => {
    const { manager, stored } = setup();
    const first = await manager.save(" Writing ", layout()); await manager.save("Reading", layout());
    const changed = layout(); changed.right.collapsed = false;
    expect((await manager.save("Writing", changed)).id).toBe(first.id);
    expect((await manager.list()).map(record => record.name)).toEqual(["Writing", "Reading"]);
    expect((await manager.get(first.id)).layout.right.collapsed).toBe(false);
    const restarted = setup(stored()); expect(await restarted.manager.list()).toHaveLength(2);
    await manager.remove(first.id); expect((await manager.list()).map(record => record.name)).toEqual(["Reading"]);
  });
  it("serializes writes and retains records after write failure", async () => {
    const { manager, config } = setup(); await manager.save("A", layout());
    config.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.save("B", layout())).rejects.toThrow("disk full");
    expect((await manager.list()).map(record => record.name)).toEqual(["A"]);
    await Promise.all([manager.save("B", layout()), manager.save("C", layout())]);
    expect((await manager.list()).map(record => record.name)).toEqual(["A", "B", "C"]);
  });
  it("refuses corrupt or unreadable records without overwriting storage", async () => {
    const { manager, config } = setup({ version: 99, layouts: [] });
    await expect(manager.save("A", layout())).rejects.toThrow(); expect(config.write).not.toHaveBeenCalled();
    config.read.mockRejectedValueOnce(new Error("unreadable")); await expect(manager.list()).rejects.toThrow("unreadable");
  });
  it("rejects an aggregate store above the byte limit before writing it", async () => {
    const { manager, config } = setup(); const large = layout() as any;
    large.center.root.leaves = [{ type: "plugin-view", state: { text: "x".repeat(1_050_000) } }];
    await manager.save("A", large); config.write.mockClear();
    const rejected = await manager.save("B", large).then(() => false, () => true); expect(rejected).toBe(true); expect(config.write).not.toHaveBeenCalled();
    expect((await manager.list()).map(record => record.name)).toEqual(["A"]);
  });
  it("rejects queued work from an old vault", async () => {
    const { manager, expire, config } = setup(); expire();
    await expect(manager.save("A", layout())).rejects.toThrow("vault"); expect(config.write).not.toHaveBeenCalled();
  });
});
describe("bounded named layout validation", () => {
  it("clones and normalizes existing schemas without changing the caller's snapshot", () => {
    const original = layout(); const result = validateNamedLayout(original); result.right.collapsed = false;
    expect(original.right.collapsed).toBe(true); expect(result.version).toBe(3);
  });
  it.each(["../Private.md", "/outside.md", "Folder/../Private.md", "https://external.md", "a\\b.md", "a\u0000b.md"])("rejects non-vault file path %s", file => {
    const value = layout(); value.center.root = tabs(file); expect(() => validateNamedLayout(value)).toThrow();
  });
  it("bounds UTF-8 bytes rather than only JavaScript character count", () => {
    const value = layout() as any; value.center.root.leaves = [{ type: "plugin-view", state: { text: "界".repeat(700_000) } }];
    expect(() => validateNamedLayout(value)).toThrow();
  });
  it("rejects invalid dimensions, tab indexes, oversized plugin state and recursive layouts", () => {
    const value = layout(); value.left.width = Infinity; expect(() => validateNamedLayout(value)).toThrow();
    value.left.width = 280; value.center.root.active = 4; expect(() => validateNamedLayout(value)).toThrow();
    const recursive: any = { type: "split", direction: "horizontal", sizes: [1], children: [] }; recursive.children.push(recursive);
    expect(() => validateNamedLayout({ ...layout(), center: { root: recursive, activeGroup: 0 } })).toThrow();
    const huge = layout() as any; huge.center.root.leaves = [{ type: "plugin-view", state: { text: "x".repeat(2_100_000) } }];
    expect(() => validateNamedLayout(huge)).toThrow();
  });
});

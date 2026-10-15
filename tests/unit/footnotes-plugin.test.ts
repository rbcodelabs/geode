import { describe, expect, it, vi } from "vitest";
const api = await import("../../src/renderer/internal-plugins/footnotes-plugin").catch(() => ({})) as typeof import("../../src/renderer/internal-plugins/footnotes-plugin");

describe("Footnotes core plugin registration", () => {
  it("registers one reusable pane command and cleans its factory/command on unload", async () => {
    expect(api.FootnotesPlugin).toBeTypeOf("function");
    const commands = new Map<string, any>();
    const leaf = { setViewState: vi.fn(async () => {}) };
    const workspace = { isDeferrableViewType: () => true, registerViewFactory: vi.fn(), unregisterViewFactory: vi.fn(async () => {}),
      getLeavesOfType: vi.fn(() => [] as any[]), getRightLeaf: vi.fn(() => leaf), revealLeaf: vi.fn() };
    const app = { workspace, commands: { add: (command: any) => commands.set(command.id, command), remove: (id: string) => commands.delete(id) } };
    const plugin = new api.FootnotesPlugin(app as any); plugin.load();
    expect(workspace.registerViewFactory).toHaveBeenCalledTimes(1);
    await commands.get("footnotes:open").callback();
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: "footnotes", active: true });
    workspace.getLeavesOfType.mockReturnValue([leaf]);
    await commands.get("footnotes:open").callback();
    expect(workspace.getRightLeaf).toHaveBeenCalledTimes(1);
    await plugin.unloadAndWait(); expect(commands.size).toBe(0); expect(workspace.unregisterViewFactory).toHaveBeenCalledWith("footnotes");
  });
});

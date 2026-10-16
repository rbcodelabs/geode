import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";

vi.mock("../../src/renderer/workspace", () => ({ buildViewHeaderNavButtons: () => ({}) }));
vi.mock("../../src/renderer/views/bases/toolbar", () => ({ BasesToolbar: class { containerEl = {}; } }));
vi.mock("../../src/renderer/views/bases/table-view", () => ({ BasesTableView: class { containerEl = {}; } }));
vi.mock("../../src/renderer/views/bases/cards-view", () => ({ BasesCardsView: class { containerEl = {}; } }));
vi.mock("../../src/renderer/views/bases/plugin-view-host", () => ({ BasesPluginViewHost: class { containerEl = {}; } }));
afterEach(() => vi.unstubAllGlobals());
it("observes a notification reload rejection and exposes a visible error", async () => {
  const element = () => ({ style: {}, appendChild() {}, append() {}, setAttribute() {} });
  vi.stubGlobal("document", { createElement: element, body: { classList: { contains: () => false } } });
  const notify = vi.fn(); const view = new BaseView({ notify } as any) as any;
  const file = { path: "Tasks.base" }; view.file = file;
  view.reloadIfChangedExternally = vi.fn(async () => { throw Error("reload read failed"); });
  view.onVaultChange(file);
  await new Promise(resolve => setImmediate(resolve));
  expect(view.reloadIfChangedExternally).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("reload read failed"));
});

import { afterEach, expect, it, vi } from "vitest";
import { renderExternalRootsTab } from "../../src/renderer/settings/external-roots-tab";
import type { ExternalRootsHost } from "../../src/shared/external-roots";
class Element {
  className = ""; textContent = ""; disabled = false; type = "";
  children: Element[] = []; listeners = new Map<string, () => void>();
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener); }
}
function nodes(node: Element): Element[] { return [node, ...node.children.flatMap(nodes)]; }
afterEach(() => vi.unstubAllGlobals());
it("offers only stale-association and orphan removal and unsubscribes on close", async () => {
  vi.stubGlobal("document", { createElement: () => new Element() });
  const container = new Element(); const stop = vi.fn();
  const host = { listGrants: vi.fn(async () => [{ root: { rootId: "root", label: "Project", availability: "connected" },
    associations: [{ projectId: "active", label: "Active", active: true }, { projectId: "stale", label: "Stale", active: false }], sharedBindingCount: 1, removable: false }]),
    removeStaleAssociation: vi.fn(async () => true), removeOrphanGrant: vi.fn(async () => true), onChange: () => stop };
  const dispose = renderExternalRootsTab(container as unknown as HTMLElement, host as unknown as ExternalRootsHost);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const text = nodes(container).map((node) => node.textContent).join(" ");
  expect(text).toContain("Active"); expect(text).toContain("Stale"); expect(text).toContain("1 association in another vault");
  expect(nodes(container).filter((node) => node.textContent === "Remove association…")).toHaveLength(1);
  expect(text).not.toContain("Remove folder grant…");
  dispose(); expect(stop).toHaveBeenCalledTimes(1);
});

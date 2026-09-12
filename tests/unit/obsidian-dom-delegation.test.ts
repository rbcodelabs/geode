import { describe, expect, it } from "vitest";
import { crossRealmInstanceOf, resolveDelegateTarget } from "../../src/renderer/api/obsidian-dom";

/**
 * `installObsidianDomExtensions` itself needs real element prototypes, and
 * vitest.config.mts runs the `node` environment (no jsdom) — the installed
 * helpers are therefore covered by the Electron e2e harness, matching the
 * note in `obsidian-compat.test.ts`.
 *
 * What *is* pure, and what these tests pin down, are the two decision
 * functions those helpers delegate to: which constructor realm counts as a
 * match, and which element a delegated event should be attributed to. Both
 * are load-bearing for hosting a Bases view — `kanban-bases-view` gates every
 * one of its link handlers on `el.instanceOf(HTMLElement)` inside an
 * `el.on(type, selector, handler)` delegated listener.
 */

class MainRealmElement {}
class OtherRealmElement {}

describe("crossRealmInstanceOf", () => {
  it("matches a same-realm instance via the native check", () => {
    expect(crossRealmInstanceOf(new MainRealmElement(), MainRealmElement)).toBe(true);
  });

  it("rejects an unrelated object", () => {
    expect(crossRealmInstanceOf(new MainRealmElement(), OtherRealmElement)).toBe(false);
  });

  it("is null/undefined safe rather than throwing", () => {
    expect(crossRealmInstanceOf(null, MainRealmElement)).toBe(false);
    expect(crossRealmInstanceOf(undefined, MainRealmElement)).toBe(false);
  });

  it("matches a node from a popout window by re-resolving the constructor in its own realm", () => {
    // The popout's element is NOT an instance of the main window's class...
    class PopoutHTMLElement {}
    const popoutWindow = { MainRealmElement: PopoutHTMLElement };
    const node = Object.assign(new PopoutHTMLElement(), {
      ownerDocument: { defaultView: popoutWindow },
    });

    expect(node instanceof MainRealmElement).toBe(false);
    // ...but instanceOf still says yes, which is the whole point of the helper.
    expect(crossRealmInstanceOf(node, MainRealmElement)).toBe(true);
  });

  it("matches a UIEvent from another realm via its `view` window", () => {
    class PopoutMouseEvent {}
    const popoutWindow = { MainRealmElement: PopoutMouseEvent };
    const evt = Object.assign(new PopoutMouseEvent(), { view: popoutWindow });

    expect(crossRealmInstanceOf(evt, MainRealmElement)).toBe(true);
  });

  it("falls back to the event target's document for a non-UI event", () => {
    class PopoutEvent {}
    const popoutWindow = { MainRealmElement: PopoutEvent };
    const evt = Object.assign(new PopoutEvent(), {
      target: { ownerDocument: { defaultView: popoutWindow } },
    });

    expect(crossRealmInstanceOf(evt, MainRealmElement)).toBe(true);
  });

  it("does not match when the other realm has no constructor of that name", () => {
    class PopoutThing {}
    const node = Object.assign(new PopoutThing(), { ownerDocument: { defaultView: {} } });
    expect(crossRealmInstanceOf(node, MainRealmElement)).toBe(false);
  });
});

/** Minimal `closest`/`contains` stand-ins — a linear ancestor chain. */
function chain(...tags: string[]) {
  const nodes = tags.map((selector) => ({
    selector,
    parent: null as any,
    closest(sel: string): any {
      let cur: any = this;
      while (cur) {
        if (cur.selector === sel) return cur;
        cur = cur.parent;
      }
      return null;
    },
  }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].parent = nodes[i + 1];
  return nodes;
}

const containerContainingAll = { contains: () => true };
const containerContainingNone = { contains: () => false };

describe("resolveDelegateTarget", () => {
  it("returns the matching ancestor of the event target", () => {
    const [leaf, , link] = chain("span", "div", "a.internal-link");
    expect(resolveDelegateTarget(leaf, "a.internal-link", containerContainingAll)).toBe(link);
  });

  it("returns the target itself when it is the match", () => {
    const [link] = chain("a.internal-link", "div");
    expect(resolveDelegateTarget(link, "a.internal-link", containerContainingAll)).toBe(link);
  });

  it("returns null when nothing in the ancestor chain matches", () => {
    const [leaf] = chain("span", "div");
    expect(resolveDelegateTarget(leaf, "a.internal-link", containerContainingAll)).toBeNull();
  });

  it("returns null when the match has escaped the container", () => {
    // e.g. a popover reparented onto document.body still bubbles through.
    const [leaf, link] = chain("span", "a.internal-link");
    expect(resolveDelegateTarget(leaf, "a.internal-link", containerContainingNone)).toBeNull();
    expect(link).toBeDefined();
  });

  it("is safe against a null target or a target with no closest()", () => {
    expect(resolveDelegateTarget(null, "a", containerContainingAll)).toBeNull();
    expect(resolveDelegateTarget({}, "a", containerContainingAll)).toBeNull();
    // window/document targets have no closest() and must not throw.
    expect(resolveDelegateTarget({ closest: undefined }, "a", containerContainingAll)).toBeNull();
  });
});

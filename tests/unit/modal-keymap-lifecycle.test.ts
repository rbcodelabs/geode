import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../../src/renderer/api/obsidian";
import { Keymap } from "../../src/renderer/api/keymap";
import { Scope } from "../../src/renderer/api/suggest";
import { FakeDocument } from "../helpers/fake-dom";

function makeApp() {
  const scope = new Scope();
  return { scope, keymap: new Keymap(scope) } as any;
}

describe("Modal keymap lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("document", new FakeDocument() as unknown as Document);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pushes and pops exactly once across repeated open and close calls", () => {
    const app = makeApp();
    const push = vi.spyOn(app.keymap, "pushScope");
    const pop = vi.spyOn(app.keymap, "popScope");
    const modal = new Modal(app);

    modal.open();
    modal.open();
    modal.close();
    modal.close();

    expect(push).toHaveBeenCalledOnce();
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("rolls back scope and DOM when onOpen throws", () => {
    const app = makeApp();
    const push = vi.spyOn(app.keymap, "pushScope");
    const pop = vi.spyOn(app.keymap, "popScope");
    class ThrowingOpenModal extends Modal {
      override onOpen(): void { throw new Error("open failed"); }
    }
    const modal = new ThrowingOpenModal(app);

    expect(() => modal.open()).toThrow("open failed");
    expect(push).toHaveBeenCalledOnce();
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("cleans up before an onClose hook throws", () => {
    const app = makeApp();
    const pop = vi.spyOn(app.keymap, "popScope");
    class ThrowingCloseModal extends Modal {
      override onClose(): void { throw new Error("close failed"); }
    }
    const modal = new ThrowingCloseModal(app);
    modal.open();

    expect(() => modal.close()).toThrow("close failed");
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(false);
    expect(() => modal.close()).not.toThrow();
  });

  it("cleans up before a close callback throws", () => {
    const app = makeApp();
    const pop = vi.spyOn(app.keymap, "popScope");
    const modal = new Modal(app).setCloseCallback(() => { throw new Error("callback failed"); });
    modal.open();

    expect(() => modal.close()).toThrow("callback failed");
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(false);
    expect(() => modal.close()).not.toThrow();
  });

  it("does not double-pop when onOpen closes and then throws", () => {
    const app = makeApp();
    const pop = vi.spyOn(app.keymap, "popScope");
    class CloseThenThrowModal extends Modal {
      override onOpen(): void {
        this.close();
        throw new Error("after close");
      }
    }
    const modal = new CloseThenThrowModal(app);

    expect(() => modal.open()).toThrow("after close");
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("preserves a new lifecycle reopened from onClose", () => {
    const app = makeApp();
    const push = vi.spyOn(app.keymap, "pushScope");
    const pop = vi.spyOn(app.keymap, "popScope");
    class ReopenFromHookModal extends Modal {
      reopen = true;
      override onClose(): void {
        if (!this.reopen) return;
        this.reopen = false;
        this.open();
      }
    }
    const modal = new ReopenFromHookModal(app);
    modal.open();

    modal.close();
    expect(push).toHaveBeenCalledTimes(2);
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(true);

    modal.close();
    expect(pop).toHaveBeenCalledTimes(2);
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("preserves a new lifecycle reopened from the close callback", () => {
    const app = makeApp();
    const push = vi.spyOn(app.keymap, "pushScope");
    const pop = vi.spyOn(app.keymap, "popScope");
    let reopen = true;
    const modal = new Modal(app).setCloseCallback(() => {
      if (!reopen) return;
      reopen = false;
      modal.open();
    });
    modal.open();

    modal.close();
    expect(push).toHaveBeenCalledTimes(2);
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(true);

    modal.close();
    expect(pop).toHaveBeenCalledTimes(2);
    expect(modal.containerEl.isConnected).toBe(false);
  });
});

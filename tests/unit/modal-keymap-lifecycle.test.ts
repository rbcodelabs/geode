import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../../src/renderer/api/obsidian";
import { Keymap } from "../../src/renderer/api/keymap";
import { Scope } from "../../src/renderer/api/suggest";
import { FakeDocument } from "../helpers/fake-dom";

function makeApp() {
  const scope = new Scope();
  return { scope, keymap: new Keymap(scope) } as any;
}

function deferred() {
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}

describe("Modal keymap lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("document", new FakeDocument() as unknown as Document);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("releases the initiating lifecycle when async onOpen rejects", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp();
    const pop = vi.spyOn(app.keymap, "popScope");
    const opening = deferred();
    class RejectingOpenModal extends Modal {
      override onOpen(): Promise<void> { return opening.promise; }
    }
    const modal = new RejectingOpenModal(app);
    const rejection = opening.promise.catch(() => undefined);

    modal.open();
    opening.reject(new Error("async open failed"));
    await rejection;
    await Promise.resolve();

    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(false);
    expect(errorLog).toHaveBeenCalledWith("Modal onOpen() rejected", expect.any(Error));
  });

  it("does not clean up twice when async onOpen rejects after close", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp();
    const pop = vi.spyOn(app.keymap, "popScope");
    const opening = deferred();
    class RejectingAfterCloseModal extends Modal {
      override onOpen(): Promise<void> { return opening.promise; }
    }
    const modal = new RejectingAfterCloseModal(app);
    const rejection = opening.promise.catch(() => undefined);

    modal.open();
    modal.close();
    opening.reject(new Error("late open failure"));
    await rejection;
    await Promise.resolve();

    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("does not remove a newer lifecycle when an earlier async onOpen rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp();
    const push = vi.spyOn(app.keymap, "pushScope");
    const pop = vi.spyOn(app.keymap, "popScope");
    const firstOpening = deferred();
    class ReopenedModal extends Modal {
      calls = 0;
      override onOpen(): Promise<void> | void {
        this.calls++;
        if (this.calls === 1) return firstOpening.promise;
      }
    }
    const modal = new ReopenedModal(app);
    const rejection = firstOpening.promise.catch(() => undefined);

    modal.open();
    modal.close();
    modal.open();
    firstOpening.reject(new Error("stale open failure"));
    await rejection;
    await Promise.resolve();

    expect(push).toHaveBeenCalledTimes(2);
    expect(pop).toHaveBeenCalledOnce();
    expect(modal.containerEl.isConnected).toBe(true);

    modal.close();
    expect(pop).toHaveBeenCalledTimes(2);
  });
});

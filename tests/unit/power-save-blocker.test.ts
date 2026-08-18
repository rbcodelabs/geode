import { describe, expect, it, vi } from "vitest";
import { PowerSaveBlockerRegistry } from "../../src/main/power-save-blocker";

function createRegistry() {
  let nextBlockerId = 40;
  const start = vi.fn(() => ++nextBlockerId);
  const stop = vi.fn();
  const registry = new PowerSaveBlockerRegistry({ start, stop });
  return { registry, start, stop };
}

describe("PowerSaveBlockerRegistry", () => {
  it("starts prevent-app-suspension and returns an opaque token", () => {
    const { registry, start } = createRegistry();

    const token = registry.acquire(7);

    expect(start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(token).not.toBe("41");
  });

  it("releases only a blocker owned by the requesting renderer", () => {
    const { registry, stop } = createRegistry();
    const token = registry.acquire(7);

    expect(registry.release(8, token)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(registry.release(7, token)).toBe(true);
    expect(stop).toHaveBeenCalledWith(41);
  });

  it("safely ignores duplicate and unknown releases", () => {
    const { registry, stop } = createRegistry();
    const token = registry.acquire(7);

    expect(registry.release(7, token)).toBe(true);
    expect(registry.release(7, token)).toBe(false);
    expect(registry.release(7, "unknown-token")).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops every blocker owned by a renderer when it is destroyed", () => {
    const { registry, stop } = createRegistry();
    const first = registry.acquire(7);
    registry.acquire(8);
    const second = registry.acquire(7);

    registry.releaseOwner(7);

    expect(stop).toHaveBeenCalledWith(41);
    expect(stop).toHaveBeenCalledWith(43);
    expect(stop).not.toHaveBeenCalledWith(42);
    expect(registry.release(7, first)).toBe(false);
    expect(registry.release(7, second)).toBe(false);
  });

  it("continues cleanup if Electron rejects one stop", () => {
    const { registry, stop } = createRegistry();
    registry.acquire(7);
    registry.acquire(7);
    stop.mockImplementationOnce(() => {
      throw new Error("already stopped");
    });

    expect(() => registry.releaseOwner(7)).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

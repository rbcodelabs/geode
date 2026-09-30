import { describe, expect, it } from "vitest";
import { computeCompleteness } from "../../src/renderer/internal-plugins/onboarding/completeness";

const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, ownerId: id.split(":")[0], ...extra });

describe("computeCompleteness", () => {
  it("counts required steps and rounds percent", () => {
    const steps = [s("a:1"), s("a:2"), s("a:3")];
    const c = computeCompleteness(steps, (id) => id === "a:1");
    expect(c).toMatchObject({ completed: 1, total: 3, percent: 33 });
  });

  it("an empty list is 100% (nothing left to do)", () => {
    expect(computeCompleteness([], () => false)).toMatchObject({ completed: 0, total: 0, percent: 100 });
  });

  it("optional steps never count toward total, completed or percent", () => {
    const steps = [s("a:1"), s("a:2", { optional: true })];
    const c = computeCompleteness(steps, () => true);
    expect(c).toMatchObject({ completed: 1, total: 1, percent: 100 });
    expect(c.optional).toEqual({ completed: 1, total: 1 });
  });

  it("skipped incomplete steps leave the required total; skipped-but-done still count", () => {
    const steps = [s("a:1"), s("a:2"), s("a:3")];
    const c = computeCompleteness(
      steps,
      (id) => id === "a:3",
      (id) => id === "a:2" || id === "a:3"
    );
    expect(c).toMatchObject({ completed: 1, total: 2, percent: 50 });
  });

  it("breaks down by group (default 'General') and by owner", () => {
    const steps = [
      s("a:1", { group: "Basics" }),
      s("a:2", { group: "Basics" }),
      s("b:1"),
      s("b:2", { optional: true, group: "Extras" }),
    ];
    const c = computeCompleteness(steps, (id) => id === "a:1" || id === "b:1");
    expect(c.byGroup).toEqual({
      Basics: { completed: 1, total: 2, percent: 50 },
      General: { completed: 1, total: 1, percent: 100 },
    });
    expect(c.byOwner).toEqual({
      a: { completed: 1, total: 2, percent: 50 },
      b: { completed: 1, total: 1, percent: 100 },
    });
    expect(c.byGroup.Extras).toBeUndefined();
  });
});

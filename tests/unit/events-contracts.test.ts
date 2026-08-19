import { describe, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";

describe("Events public contract", () => {
  it("passes trigger arguments and applies the optional callback context", () => {
    const events = new Events();
    const context = { prefix: "ctx" };
    const seen: string[] = [];
    events.on(
      "change",
      function (this: typeof context, left, right) {
        seen.push(`${this.prefix}:${String(left)}:${String(right)}`);
      },
      context,
    );

    events.trigger("change", "a", 2);
    expect(seen).toEqual(["ctx:a:2"]);
  });

  it("off removes registrations matching an event name and callback", () => {
    const events = new Events();
    const callback = vi.fn();
    events.on("first", callback);
    events.on("second", callback);

    events.off("first", callback);
    events.trigger("first");
    events.trigger("second");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("offref removes only the referenced registration", () => {
    const events = new Events();
    const callback = vi.fn();
    const first = events.on("change", callback);
    events.on("change", callback);

    events.offref(first);
    events.trigger("change", "remaining");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("remaining");
  });

  it("tryTrigger invokes one active event reference with the supplied args and context", () => {
    const events = new Events();
    const context = { value: 4 };
    const callback = vi.fn(function (this: typeof context, increment: number) {
      return this.value + increment;
    });
    const ref = events.on("calculate", callback, context);

    events.tryTrigger(ref, [3]);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.instances[0]).toBe(context);
    expect(callback).toHaveBeenCalledWith(3);

    events.offref(ref);
    events.tryTrigger(ref, [5]);
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe("Component and Events through plugin require('obsidian')", () => {
  it("exposes lifecycle registration and all event operations to CommonJS plugins", () => {
    const PluginClass = instantiatePluginClass(
      `
        const { Component, Events } = require("obsidian");
        module.exports = class LifecycleProbe {
          static results = (() => {
            const events = new Events();
            const component = new Component();
            const context = { value: "bound" };
            const calls = [];
            const callback = function (value) { calls.push(this.value + ":" + value); };
            const registered = events.on("event", callback, context);
            component.registerEvent(registered);
            const direct = events.on("direct", callback, context);
            events.trigger("event", 1);
            events.tryTrigger(direct, [2]);
            events.offref(direct);
            component.unload();
            events.trigger("event", 3);
            return calls;
          })();
        };
      `,
      "lifecycle-probe",
    ) as unknown as { results: string[] };

    expect(PluginClass.results).toEqual(["bound:1", "bound:2"]);
  });
});

import { describe, expect, it } from "vitest";
import { parseBaseFile } from "../../src/renderer/bases/base-file";
import { stringifyBaseFile } from "../../src/renderer/bases/base-file-write";

/**
 * `.base` files are hand-editable, and (once plugins can register their own
 * Bases view types) they also carry per-view settings this app has never heard
 * of. Both `parseBaseFile` and `stringifyBaseFile` used to model the schema as
 * closed: any key they did not recognise was dropped on read, and therefore
 * absent on the next write. The first toolbar interaction after opening such a
 * file silently destroyed the rest of it.
 *
 * These tests pin the round-trip contract: parse -> serialize -> parse must
 * preserve every key, known or not, at both the view level and the
 * per-property level.
 */

function roundTrip(yaml: string) {
  const first = parseBaseFile(yaml);
  if ("error" in first) throw new Error(`parse failed: ${first.error}`);
  const reserialized = stringifyBaseFile(first.def);
  const second = parseBaseFile(reserialized);
  if ("error" in second) throw new Error(`re-parse failed: ${second.error}`);
  return { def: first.def, reserialized, def2: second.def };
}

describe("unknown view keys survive a parse/serialize round trip", () => {
  const yaml = [
    "views:",
    "  - type: kanban-view",
    "    name: Board",
    "    order:",
    "      - note.status",
    "    groupByProperty: note.status",
    "    collapsedLanes:",
    "      - Done",
    "    columnOrders:",
    "      note.status:",
    "        - To Do",
    "        - Doing",
    "        - Done",
    "    columnColors:",
    "      note.status:",
    "        Done: green",
    "    wrapPropertyValues: true",
    "    imageAspectRatio: 0.5",
    "",
  ].join("\n");

  it("keeps the keys it already understood", () => {
    const { def } = roundTrip(yaml);
    expect(def.views[0].type).toBe("kanban-view");
    expect(def.views[0].name).toBe("Board");
    expect(def.views[0].order).toEqual(["note.status"]);
    // imageAspectRatio is a known key and must stay strongly typed, not
    // get swept into the passthrough bag.
    expect(def.views[0].imageAspectRatio).toBe(0.5);
    expect(def.views[0].extra).not.toHaveProperty("imageAspectRatio");
  });

  it("captures every unrecognised key in `extra`", () => {
    const { def } = roundTrip(yaml);
    expect(def.views[0].extra).toEqual({
      groupByProperty: "note.status",
      collapsedLanes: ["Done"],
      columnOrders: { "note.status": ["To Do", "Doing", "Done"] },
      columnColors: { "note.status": { Done: "green" } },
      wrapPropertyValues: true,
    });
  });

  it("writes those keys back out, so nothing is lost on the next save", () => {
    const { reserialized, def2 } = roundTrip(yaml);
    expect(reserialized).toContain("groupByProperty");
    expect(reserialized).toContain("columnOrders");
    expect(reserialized).toContain("collapsedLanes");
    expect(def2.views[0].extra).toEqual({
      groupByProperty: "note.status",
      collapsedLanes: ["Done"],
      columnOrders: { "note.status": ["To Do", "Doing", "Done"] },
      columnColors: { "note.status": { Done: "green" } },
      wrapPropertyValues: true,
    });
    expect(def2.views[0].imageAspectRatio).toBe(0.5);
  });

  it("lets a known key win over a stale same-named entry in `extra`", () => {
    const { def } = roundTrip(yaml);
    // Nothing should ever put a known key in `extra`, but if a caller does,
    // the typed field is authoritative on write.
    def.views[0].extra = { ...def.views[0].extra, name: "Stale" };
    const out = parseBaseFile(stringifyBaseFile(def));
    if ("error" in out) throw new Error(out.error);
    expect(out.def.views[0].name).toBe("Board");
  });

  it("does not invent an `extra` key for a view that has no unknown keys", () => {
    const { def, reserialized } = roundTrip("views:\n  - type: table\n    name: All\n");
    expect(def.views[0].extra).toBeUndefined();
    expect(reserialized).not.toContain("extra");
  });
});

describe("unknown per-property config survives a parse/serialize round trip", () => {
  const yaml = [
    "properties:",
    "  note.status:",
    "    displayName: Status",
    "    typeInfo: select",
    "    options:",
    "      - To Do",
    "      - Done",
    "  note.owner:",
    "    color: blue",
    "views:",
    "  - type: table",
    "    name: All",
    "",
  ].join("\n");

  it("keeps displayName alongside the unknown per-property keys", () => {
    const { def } = roundTrip(yaml);
    expect(def.properties["note.status"].displayName).toBe("Status");
    expect(def.properties["note.status"].extra).toEqual({
      typeInfo: "select",
      options: ["To Do", "Done"],
    });
  });

  it("preserves a property entry that has ONLY unknown keys", () => {
    // Previously dropped entirely: no displayName meant nothing was written.
    const { def2 } = roundTrip(yaml);
    expect(def2.properties["note.owner"]).toBeDefined();
    expect(def2.properties["note.owner"].extra).toEqual({ color: "blue" });
  });

  it("writes per-property config back out", () => {
    const { reserialized, def2 } = roundTrip(yaml);
    expect(reserialized).toContain("typeInfo");
    expect(reserialized).toContain("color");
    expect(def2.properties["note.status"].displayName).toBe("Status");
    expect(def2.properties["note.status"].extra).toEqual({
      typeInfo: "select",
      options: ["To Do", "Done"],
    });
  });
});

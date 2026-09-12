import { describe, expect, it } from "vitest";
import {
  BasesEntry,
  BasesEntryGroup,
  BasesViewConfig,
  toBasesQueryResult,
  type EntryEvalDeps,
  type SummaryDeps,
} from "../../src/renderer/api/bases-data";
import { NullValue, StringValue } from "../../src/renderer/api/bases-values";
import type { BaseDefinition, BaseViewDefinition } from "../../src/renderer/bases/base-file";
import { runQuery } from "../../src/renderer/bases/query-engine";
import type { MetadataCacheReader, VaultReader } from "../../src/renderer/bases/eval-context";
import type { CachedMetadata, TFile } from "../../src/renderer/types";

/**
 * The adapters between the query engine and a hosted Bases view. The case
 * that matters most is lazy `getValue`: `runQuery` only materializes the
 * property paths named in `view.order`, but a Kanban view groups by a
 * property it deliberately keeps *out* of `order`, so a precomputed-map
 * lookup would return nothing and drop every card into "Uncategorized".
 */

function file(path: string): TFile {
  const name = path.split("/").pop()!;
  return {
    kind: "file",
    path,
    name,
    basename: name.replace(/\.md$/, ""),
    extension: "md",
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: "",
  } as TFile;
}

const files = [file("A.md"), file("B.md"), file("C.md")];
const frontmatter: Record<string, Record<string, unknown>> = {
  "A.md": { status: "To Do", owner: "rick", points: 3 },
  "B.md": { status: "Done", owner: "sam", points: 5 },
  "C.md": { status: "To Do", owner: "rick", points: 1 },
};

const vault: VaultReader = {
  getFileByPath: (p) => files.find((f) => f.path === p) ?? null,
  getMarkdownFiles: () => files,
  getFiles: () => files,
};
const metadataCache: MetadataCacheReader = {
  getFileCache: (f) => ({ frontmatter: frontmatter[f.path] }) as CachedMetadata,
  getBacklinks: () => [],
  getFirstLinkpathDest: () => null,
};

const deps: EntryEvalDeps = { vault, metadataCache, formulas: {}, thisFile: null, now: 0 };

describe("BasesEntry.getValue evaluates on demand", () => {
  it("resolves a property that was never in view.order", () => {
    // Nothing seeded at all — the whole value has to be computed lazily.
    const entry = new BasesEntry(files[0], deps);
    expect(entry.getValue("note.status")?.toString()).toBe("To Do");
    expect(entry.getValue("note.owner")?.toString()).toBe("rick");
  });

  it("accepts a bare shorthand id as well as a prefixed one", () => {
    const entry = new BasesEntry(files[0], deps);
    expect(entry.getValue("status")?.toString()).toBe("To Do");
  });

  it("resolves file.* properties", () => {
    const entry = new BasesEntry(files[0], deps);
    expect(entry.getValue("file.name")?.toString()).toBe("A.md");
  });

  it("returns NullValue (not null) for a property that simply isn't set", () => {
    const entry = new BasesEntry(files[0], deps);
    expect(entry.getValue("note.nope")).toBe(NullValue.value);
  });

  it("prefers a seeded value over re-evaluating, and keys the seed by prefixed id", () => {
    const entry = new BasesEntry(files[0], deps, {
      properties: { "note.status": { type: "string", value: "SEEDED" } },
      formulas: { total: { type: "number", value: 42 } },
    });
    expect(entry.getValue("note.status")?.toString()).toBe("SEEDED");
    // Seeded under the engine path "status"? Still reachable by either form.
    expect(entry.getValue("status")?.toString()).toBe("SEEDED");
    expect(entry.getValue("formula.total")?.toString()).toBe("42");
  });

  it("memoizes, so repeated reads return the identical instance", () => {
    const entry = new BasesEntry(files[0], deps);
    expect(entry.getValue("note.status")).toBe(entry.getValue("note.status"));
  });
});

describe("toBasesQueryResult", () => {
  const def: BaseDefinition = {
    filters: undefined,
    formulas: {},
    properties: { "note.owner": { displayName: "Assignee" } },
    summaries: { headcount: "values.length" },
    views: [{ type: "kanban-view", name: "Board", order: ["note.owner"] }],
  };

  function run(view: BaseViewDefinition) {
    const d: BaseDefinition = { ...def, views: [view] };
    const result = runQuery(d, view.name, files, vault, metadataCache, null, 0);
    if ("error" in result) throw new Error(result.error);
    const summaryDeps: SummaryDeps = { ...deps, summaries: d.summaries, anchorFile: files[0] };
    return toBasesQueryResult(result, view.order ?? [], summaryDeps);
  }

  it("exposes ungrouped data as entries", () => {
    const r = run(def.views[0]);
    expect(r.data).toHaveLength(3);
    expect(r.data[0]).toBeInstanceOf(BasesEntry);
  });

  it("normalizes visible properties to prefixed ids", () => {
    const r = run({ type: "kanban-view", name: "Board", order: ["owner", "file.name"] });
    expect(r.properties).toEqual(["note.owner", "file.name"]);
  });

  it("groups by a property that is NOT in view.order — the case a precomputed map fails", () => {
    // `order` lists owner only; grouping is by status.
    const r = run({
      type: "kanban-view",
      name: "Board",
      order: ["note.owner"],
      groupBy: { property: "note.status", direction: "ASC" },
    });
    const keys = r.groupedData.map((g) => g.key?.toString());
    expect(keys.sort()).toEqual(["Done", "To Do"]);
    // And each entry can still read the grouping property directly.
    for (const group of r.groupedData) {
      for (const entry of group.entries) {
        expect(entry.getValue("note.status")?.toString()).toBe(group.key?.toString());
      }
    }
  });

  it("returns one keyless group when no groupBy is configured", () => {
    const r = run(def.views[0]);
    expect(r.groupedData).toHaveLength(1);
    expect(r.groupedData[0].hasKey()).toBe(false);
    expect(r.groupedData[0].entries).toHaveLength(3);
  });

  it("shares one entry instance between data and groupedData", () => {
    const r = run({
      type: "kanban-view",
      name: "Board",
      order: ["note.owner"],
      groupBy: { property: "note.status", direction: "ASC" },
    });
    const grouped = r.groupedData.flatMap((g) => g.entries);
    for (const entry of grouped) expect(r.data).toContain(entry);
    expect(grouped).toHaveLength(r.data.length);
  });

  it("computes a named summary across a set of entries", () => {
    const r = run(def.views[0]);
    expect(r.getSummaryValue(null, r.data, "note.owner", "headcount").toString()).toBe("3");
  });

  it("returns NullValue for a summary key it does not implement, rather than guessing", () => {
    const r = run(def.views[0]);
    expect(r.getSummaryValue(null, r.data, "note.points", "Average")).toBe(NullValue.value);
  });
});

describe("BasesEntryGroup.hasKey", () => {
  it("is false for an absent key and for an explicit null key", () => {
    expect(new BasesEntryGroup([]).hasKey()).toBe(false);
    expect(new BasesEntryGroup([], NullValue.value).hasKey()).toBe(false);
  });

  it("is true for a real key", () => {
    expect(new BasesEntryGroup([], new StringValue("To Do")).hasKey()).toBe(true);
  });
});

describe("BasesViewConfig", () => {
  function makeConfig(view: Partial<BaseViewDefinition> = {}, columns: string[] = []) {
    const v: BaseViewDefinition = { type: "kanban-view", name: "Board", ...view };
    const d: BaseDefinition = {
      filters: undefined,
      formulas: {},
      properties: { "note.owner": { displayName: "Assignee" }, status: { displayName: "State" } },
      summaries: {},
      views: [v],
    };
    let persisted = 0;
    const config = new BasesViewConfig(v, d, () => columns, () => void persisted++, {
      ...deps,
      thisFile: files[0],
    });
    return { config, view: v, persistCount: () => persisted };
  }

  it("reads and writes through the `.base` passthrough bag", () => {
    const { config, view } = makeConfig();
    expect(config.get("columnOrders")).toBeUndefined();
    config.set("columnOrders", { "note.status": ["To Do", "Done"] });
    expect(config.get("columnOrders")).toEqual({ "note.status": ["To Do", "Done"] });
    // Written where stringifyBaseFile will actually serialize it.
    expect(view.extra).toEqual({ columnOrders: { "note.status": ["To Do", "Done"] } });
  });

  it("persists on every set", () => {
    const { config, persistCount } = makeConfig();
    config.set("a", 1);
    config.set("b", 2);
    expect(persistCount()).toBe(2);
  });

  it("deletes a key rather than writing null into the user's YAML", () => {
    const { config, view } = makeConfig({ extra: { a: 1, b: 2 } });
    config.set("a", null);
    expect(view.extra).toEqual({ b: 2 });
    config.set("b", null);
    expect(view.extra).toBeUndefined();
  });

  it("reads a stored setting as a normalized property id", () => {
    const { config } = makeConfig({ extra: { groupByProperty: "status" } });
    expect(config.getAsPropertyId("groupByProperty")).toBe("note.status");
  });

  it("reads a missing or unusable setting as 'not configured'", () => {
    const { config } = makeConfig({ extra: { groupByProperty: "  ", other: 7 } });
    expect(config.getAsPropertyId("groupByProperty")).toBeNull();
    expect(config.getAsPropertyId("other")).toBeNull();
    expect(config.getAsPropertyId("absent")).toBeNull();
  });

  it("returns the resolved columns as prefixed ids", () => {
    const { config } = makeConfig({}, ["file.name", "note.owner", "status"]);
    expect(config.getOrder()).toEqual(["file.name", "note.owner", "note.status"]);
  });

  it("normalizes sort config and drops invalid entries", () => {
    const { config } = makeConfig({
      sort: [
        { property: "status", direction: "DESC" },
        { property: "", direction: "ASC" },
      ],
    });
    expect(config.getSort()).toEqual([{ property: "note.status", direction: "DESC" }]);
  });

  it("prefers a user displayName override, keyed either prefixed or bare", () => {
    const { config } = makeConfig();
    expect(config.getDisplayName("note.owner")).toBe("Assignee");
    expect(config.getDisplayName("owner")).toBe("Assignee");
    // `properties` keyed bare in the .base file still matches.
    expect(config.getDisplayName("note.status")).toBe("State");
  });

  it("falls back to the prefix-stripped name, not the raw path", () => {
    const { config } = makeConfig();
    expect(config.getDisplayName("note.points")).toBe("points");
    expect(config.getDisplayName("file.name")).toBe("name");
  });

  it("exposes the view name", () => {
    const { config } = makeConfig();
    expect(config.name).toBe("Board");
  });

  describe("getEvaluatedFormula", () => {
    it("evaluates a stored formula against the contextual file", () => {
      // files[0] is A.md, whose frontmatter has status "To Do".
      const { config } = makeConfig({ extra: { label: 'note.status + " (" + file.name + ")"' } });
      expect(config.getEvaluatedFormula(null, "label").toString()).toBe("To Do (A.md)");
    });

    it("degrades to NullValue rather than throwing on a malformed formula", () => {
      const { config } = makeConfig({ extra: { label: "note.status +++" } });
      expect(config.getEvaluatedFormula(null, "label")).toBe(NullValue.value);
    });

    it("returns NullValue for an absent or non-string key", () => {
      const { config } = makeConfig({ extra: { label: 7 } });
      expect(config.getEvaluatedFormula(null, "label")).toBe(NullValue.value);
      expect(config.getEvaluatedFormula(null, "absent")).toBe(NullValue.value);
    });
  });
});

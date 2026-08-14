import { describe, expect, it } from "vitest";
import {
  conditionToExprString,
  emptyGroup,
  groupToNode,
  parseConditionExpr,
  parseNodeToGroup,
  type FilterCondition,
  type FilterGroup,
} from "../../../src/renderer/bases/filter-groups";
import { parseFilterTree } from "../../../src/renderer/bases/filter-parser";

describe("conditionToExprString", () => {
  it("quotes string values and leaves numeric/boolean literals bare", () => {
    expect(conditionToExprString({ kind: "condition", property: "note.status", operator: "==", value: "Done" })).toBe(
      'note.status == "Done"'
    );
    expect(conditionToExprString({ kind: "condition", property: "note.priority", operator: ">", value: "2" })).toBe(
      "note.priority > 2"
    );
    expect(conditionToExprString({ kind: "condition", property: "note.done", operator: "==", value: "true" })).toBe(
      "note.done == true"
    );
  });

  it("builds contains/does-not-contain/isEmpty forms", () => {
    expect(
      conditionToExprString({ kind: "condition", property: "note.tags", operator: "contains", value: "urgent" })
    ).toBe('note.tags.contains("urgent")');
    expect(
      conditionToExprString({ kind: "condition", property: "note.tags", operator: "does not contain", value: "urgent" })
    ).toBe('not note.tags.contains("urgent")');
    expect(conditionToExprString({ kind: "condition", property: "note.tags", operator: "is empty", value: "" })).toBe(
      "note.tags.isEmpty()"
    );
    expect(conditionToExprString({ kind: "condition", property: "note.tags", operator: "is not empty", value: "" })).toBe(
      "not note.tags.isEmpty()"
    );
  });

  it("round-trips through parseConditionExpr for every operator", () => {
    const conditions: FilterCondition[] = [
      { kind: "condition", property: "note.status", operator: "==", value: "Done" },
      { kind: "condition", property: "note.status", operator: "!=", value: "Done" },
      { kind: "condition", property: "note.priority", operator: ">", value: "2" },
      { kind: "condition", property: "note.priority", operator: "<", value: "2" },
      { kind: "condition", property: "note.priority", operator: ">=", value: "2" },
      { kind: "condition", property: "note.priority", operator: "<=", value: "2" },
      { kind: "condition", property: "note.tags", operator: "contains", value: "urgent" },
      { kind: "condition", property: "note.tags", operator: "does not contain", value: "urgent" },
      { kind: "condition", property: "note.tags", operator: "is empty", value: "" },
      { kind: "condition", property: "note.tags", operator: "is not empty", value: "" },
    ];
    for (const cond of conditions) {
      const expr = conditionToExprString(cond);
      expect(parseConditionExpr(expr)).toEqual(cond);
    }
  });

  it("every generated expression is valid per parseFilterTree (the real engine)", () => {
    const cond: FilterCondition = { kind: "condition", property: "note.status", operator: "==", value: "Done" };
    const result = parseFilterTree(conditionToExprString(cond));
    expect("tree" in result).toBe(true);
  });
});

describe("parseConditionExpr", () => {
  it("returns null for an expression the GUI doesn't understand", () => {
    expect(parseConditionExpr("note.priority + 1")).toBeNull();
    expect(parseConditionExpr('file.hasTag("x")')).toBeNull();
  });
});

describe("groupToNode / parseNodeToGroup", () => {
  it("serializes a flat AND group of conditions to the FilterNode YAML shape", () => {
    const group: FilterGroup = {
      kind: "group",
      conjunction: "and",
      children: [
        { kind: "condition", property: "note.status", operator: "==", value: "Done" },
        { kind: "condition", property: "note.priority", operator: ">", value: "1" },
      ],
    };
    expect(groupToNode(group)).toEqual({ and: ['note.status == "Done"', "note.priority > 1"] });
  });

  it("round-trips nested and/or/not groups through parseNodeToGroup", () => {
    const group: FilterGroup = {
      kind: "group",
      conjunction: "or",
      children: [
        { kind: "condition", property: "note.status", operator: "==", value: "Done" },
        emptyGroup("not"),
      ],
    };
    (group.children[1] as FilterGroup).children.push({
      kind: "condition",
      property: "note.tags",
      operator: "is empty",
      value: "",
    });
    const node = groupToNode(group);
    expect(parseNodeToGroup(node)).toEqual(group);
  });

  it("returns null for a node shape it can't reconstruct (unknown leaf pattern)", () => {
    expect(parseNodeToGroup({ or: ['file.hasTag("book")'] })).toBeNull();
  });

  it("returns null for a plain leaf-string top-level node (GUI always edits a group)", () => {
    expect(parseNodeToGroup("note.status == \"Done\"")).toBeNull();
  });

  it("returns null for a non-object, non-and/or/not node", () => {
    expect(parseNodeToGroup(42)).toBeNull();
    expect(parseNodeToGroup({ nope: [] })).toBeNull();
  });

  it("groupToNode output parses cleanly via the real parseFilterTree", () => {
    const group: FilterGroup = {
      kind: "group",
      conjunction: "and",
      children: [{ kind: "condition", property: "note.status", operator: "!=", value: "Done" }],
    };
    const result = parseFilterTree(groupToNode(group));
    expect("tree" in result).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { findSlashTrigger, rankSlashCommands } from "../../src/renderer/internal-plugins/slash-commands/slash-trigger";
import { SlashCommandsPlugin } from "../../src/renderer/internal-plugins/slash-commands/slash-commands-plugin";
import { fuzzyMatch } from "../../src/renderer/modals/modals";

describe("findSlashTrigger", () => {
  it("opens at the start of a line", () => {
    expect(findSlashTrigger("/")).toEqual({ offset: 0, query: "" });
    expect(findSlashTrigger("/scf")).toEqual({ offset: 0, query: "scf" });
  });

  it("opens after whitespace", () => {
    expect(findSlashTrigger("hello /rea")).toEqual({ offset: 6, query: "rea" });
    expect(findSlashTrigger("\t/x")).toEqual({ offset: 1, query: "x" });
  });

  it("does not open mid-word or inside URLs", () => {
    expect(findSlashTrigger("and/or")).toBeNull();
    expect(findSlashTrigger("see http://example.com")).toBeNull();
    expect(findSlashTrigger("[[a/b")).toBeNull();
  });

  it("cancels once whitespace follows the query", () => {
    expect(findSlashTrigger("/save ")).toBeNull();
    expect(findSlashTrigger("/save current")).toBeNull();
    expect(findSlashTrigger("/ ")).toBeNull();
  });
});

describe("rankSlashCommands", () => {
  const commands = [
    { name: "Toggle reading view" },
    { name: "Save current file" },
    { name: "Create new note" },
  ];

  it("keeps everything for an empty query, alphabetically", () => {
    expect(rankSlashCommands(commands, "", fuzzyMatch).map((c) => c.name)).toEqual([
      "Create new note",
      "Save current file",
      "Toggle reading view",
    ]);
  });

  it("fuzzy-matches like the Command palette (scf -> Save current file)", () => {
    expect(rankSlashCommands(commands, "scf", fuzzyMatch).map((c) => c.name)).toEqual(["Save current file"]);
  });

  it("drops non-matching commands", () => {
    expect(rankSlashCommands(commands, "zzz", fuzzyMatch)).toEqual([]);
  });
});

describe("SlashCommandsPlugin completion source", () => {
  function setup(doc: string, executed: string[]) {
    const app = {
      commands: {
        list: () => [
          { id: "a", name: "Toggle reading view" },
          { id: "b", name: "Save current file" },
        ],
        execute: (id: string) => { executed.push(id); return true; },
      },
    };
    const plugin = new SlashCommandsPlugin(app as never);
    const state = EditorState.create({ doc });
    const ctx = new CompletionContext(state, doc.length, false);
    return { plugin, ctx };
  }

  it("offers commands from the registry with from at the slash", () => {
    const { plugin, ctx } = setup("text /scf", []);
    const result = plugin.completionSource(ctx);
    expect(result?.from).toBe(5);
    expect(result?.filter).toBe(false);
    expect(result?.options.map((o) => o.label)).toEqual(["Save current file"]);
  });

  it("returns null when there is no trigger or no match", () => {
    expect(setup("plain", []).plugin.completionSource(setup("plain", []).ctx)).toBeNull();
    const { plugin, ctx } = setup("/zzz", []);
    expect(plugin.completionSource(ctx)).toBeNull();
  });

  it("removes the trigger text and runs the command on apply", () => {
    const executed: string[] = [];
    const { plugin, ctx } = setup("hi /rea", executed);
    const option = plugin.completionSource(ctx)!.options[0];
    const dispatched: unknown[] = [];
    const view = { dispatch: (spec: unknown) => dispatched.push(spec) };
    (option.apply as (v: unknown, c: unknown, from: number, to: number) => void)(view, option, 3, 7);
    expect(dispatched).toEqual([{ changes: { from: 3, to: 7, insert: "" }, selection: { anchor: 3 } }]);
    expect(executed).toEqual(["a"]);
  });
});

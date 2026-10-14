import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type { App } from "../../app";
import type { Command } from "../../commands";
import { fuzzyMatch } from "../../modals/modals";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { findSlashTrigger, rankSlashCommands } from "./slash-trigger";

export const SLASH_COMMANDS_PLUGIN_MANIFEST: PluginManifest = {
  id: "slash-command",
  name: "Slash commands",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Perform commands inside the editor using the / key.",
  author: "Geode",
};

/**
 * Slash commands core plugin. Typing `/` at the start of a line or after
 * whitespace opens a menu over the Command palette's registry; choosing an
 * entry removes the typed trigger text and runs the command. The editor
 * consults `completionSource` from its autocompletion extension.
 */
export class SlashCommandsPlugin extends GeodePlugin {
  constructor(app: App) {
    super(app, SLASH_COMMANDS_PLUGIN_MANIFEST);
  }

  onload(): void {}

  readonly completionSource = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const trigger = findSlashTrigger(line.text.slice(0, ctx.pos - line.from));
    if (!trigger) return null;
    const commands = rankSlashCommands(this.app.commands.list(), trigger.query, fuzzyMatch);
    if (commands.length === 0) return null;
    return {
      from: line.from + trigger.offset,
      filter: false,
      options: commands.map((command) => ({
        label: command.name,
        apply: (view: EditorView, _completion: unknown, from: number, to: number) =>
          this.runCommand(view, command, from, to),
      })),
    };
  };

  private runCommand(view: EditorView, command: Command, from: number, to: number): void {
    view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
    this.app.commands.execute(command.id);
  }
}

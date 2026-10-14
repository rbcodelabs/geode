import type { App } from "../../app";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { setIcon } from "../../api/icons";
import { Modal } from "../../modals/modals";
import {
  DEFAULT_CONVERTER_OPTIONS,
  anyConversionEnabled,
  convertVault,
  type ConvertVaultResult,
  type FormatConverterOptions,
  type ZettelkastenLinkStyle,
} from "../../format-converter";

export const FORMAT_CONVERTER_PLUGIN_MANIFEST: PluginManifest = {
  id: "format-converter",
  name: "Format converter",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Convert Markdown from other apps to Obsidian format.",
  author: "Geode",
};

/**
 * Format converter core plugin: a ribbon icon and the "Open format converter"
 * command open a modal with one checkbox per conversion and a Start conversion
 * button that rewrites the whole vault in one pass.
 */
export class FormatConverterPlugin extends GeodePlugin {
  constructor(app: App) {
    super(app, FORMAT_CONVERTER_PLUGIN_MANIFEST);
  }

  onload(): void {
    const open = () => new FormatConverterModal(this.app).open();

    const el = document.createElement("button");
    el.type = "button";
    el.className = "side-dock-ribbon-action format-converter-ribbon";
    setIcon(el, "binary");
    el.setAttribute("aria-label", "Open format converter");
    el.title = "Open format converter";
    el.addEventListener("click", open);
    this.app.addRibbonIcon(el);
    this.register(() => el.remove());

    this.addCommand({ id: "open", name: "Open format converter", callback: open });
  }
}

export class FormatConverterModal extends Modal {
  private options: FormatConverterOptions = { ...DEFAULT_CONVERTER_OPTIONS };
  private running = false;

  constructor(app: App) {
    super(app);
    this.modalEl.classList.add("format-converter-modal");
  }

  onOpen(): void {
    this.render();
  }

  private render(summary?: ConvertVaultResult): void {
    const root = this.contentEl;
    root.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Format converter";
    const warning = document.createElement("p");
    warning.className = "format-converter-warning mod-warning";
    warning.textContent =
      "Format converter converts your entire vault based on the options below. Back up your vault before you start.";
    root.append(heading, warning);

    const group = (title: string): HTMLElement => {
      const section = document.createElement("div");
      section.className = "format-converter-group";
      const h = document.createElement("h3");
      h.textContent = title;
      section.appendChild(h);
      root.appendChild(section);
      return section;
    };
    const checkbox = (parent: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void) => {
      const row = document.createElement("label");
      row.className = "format-converter-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      input.addEventListener("change", () => {
        onChange(input.checked);
        this.syncStart();
      });
      row.append(input, document.createTextNode(` ${label}`));
      parent.appendChild(row);
      return input;
    };

    const roam = group("Roam Research");
    checkbox(roam, "Convert #tag and #[[tag]] to [[tag]]", this.options.roamTags, (v) => (this.options.roamTags = v));
    checkbox(roam, "Convert ^^highlight^^ to ==highlight==", this.options.roamHighlights, (v) => (this.options.roamHighlights = v));
    checkbox(roam, "Convert {{[[TODO]]}} to [ ]", this.options.roamTodos, (v) => (this.options.roamTodos = v));

    const bear = group("Bear");
    checkbox(bear, "Convert ::highlight:: to ==highlight==", this.options.bearHighlights, (v) => (this.options.bearHighlights = v));

    const zk = group("Zettelkasten links");
    const style = document.createElement("select");
    style.setAttribute("aria-label", "Zettelkasten link style");
    for (const [value, label] of [
      ["full", "Full links: [[UID File Name]]"],
      ["pretty", "Pretty links: [[UID File Name|File Name]]"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      style.appendChild(opt);
    }
    style.value = this.options.zettelkasten ?? "full";
    style.disabled = this.options.zettelkasten === null;
    style.addEventListener("change", () => {
      this.options.zettelkasten = style.value as ZettelkastenLinkStyle;
    });
    checkbox(zk, "Convert [[UID]] links to include the file name", this.options.zettelkasten !== null, (v) => {
      this.options.zettelkasten = v ? (style.value as ZettelkastenLinkStyle) : null;
      style.disabled = !v;
    });
    zk.appendChild(style);

    const props = group("Properties");
    checkbox(
      props,
      "Convert alias, tag and cssclass to aliases, tags and cssclasses lists",
      this.options.properties,
      (v) => (this.options.properties = v)
    );

    const footer = document.createElement("div");
    footer.className = "format-converter-footer";
    const status = document.createElement("p");
    status.className = "format-converter-status";
    status.setAttribute("role", "status");
    if (summary) {
      status.textContent =
        `Converted ${summary.changed.length} of ${summary.scanned} notes.` +
        (summary.failed.length ? ` ${summary.failed.length} failed: ${summary.failed.map((f) => f.path).join(", ")}` : "");
    }
    const start = document.createElement("button");
    start.className = "mod-cta format-converter-start";
    start.textContent = "Start conversion";
    start.addEventListener("click", () => void this.start());
    footer.append(status, start);
    root.appendChild(footer);
    this.syncStart();
  }

  private syncStart(): void {
    const start = this.contentEl.querySelector<HTMLButtonElement>(".format-converter-start");
    if (start) start.disabled = this.running || !anyConversionEnabled(this.options);
  }

  private async start(): Promise<void> {
    if (this.running || !anyConversionEnabled(this.options)) return;
    this.running = true;
    this.syncStart();
    try {
      const vault = this.app.vault;
      const result = await convertVault(
        {
          files: vault.getMarkdownFiles().map((f) => ({ path: f.path, basename: f.basename })),
          read: async (path) => {
            const file = vault.getFileByPath(path);
            if (!file) throw new Error("File not found");
            return vault.read(file);
          },
          write: async (path, content) => {
            const file = vault.getFileByPath(path);
            if (!file) throw new Error("File not found");
            await vault.modify(file, content);
          },
        },
        this.options
      );
      this.running = false;
      this.render(result);
      this.app.notify(`Format converter: converted ${result.changed.length} of ${result.scanned} notes.`);
    } catch (error) {
      this.running = false;
      console.error(error);
      this.app.notify(`Format converter failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.syncStart();
    }
  }
}

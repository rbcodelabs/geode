// Minimal ambient surface of the host modules this plugin uses (provided by the plugin loader's require shim).
declare module "geode" {
  export class SyncPreconditionError extends Error {}
}

declare module "obsidian" {
  import type { SyncProvider } from "../../../src/renderer/sync/types";
  export class Notice {
    constructor(message: string, timeout?: number);
  }
  export class Plugin {
    app: { vault: { root: string }; sync: { getActiveProvider(): { id: string; name: string } | null } };
    registerSyncProvider(provider: SyncProvider): void;
    addSettingTab(tab: PluginSettingTab): void;
    loadData(): Promise<any>;
    saveData(data: unknown): Promise<void>;
    onload(): void | Promise<void>;
  }
  export class PluginSettingTab {
    containerEl: HTMLElement & { empty(): void; createEl(tag: string, opts?: { text?: string; cls?: string }): HTMLElement & { setText(t: string): void } };
    constructor(app: any, plugin: Plugin);
    display(): void;
  }
  export class Setting {
    constructor(containerEl: HTMLElement);
    setName(name: string): this;
    setDesc(desc: string): this;
    addText(cb: (c: { setValue(v: string): any; onChange(cb: (v: string) => any): any }) => any): this;
    addButton(cb: (c: { setButtonText(t: string): any; onClick(cb: () => any): any }) => any): this;
    addDropdown(cb: (c: { addOption(v: string, d: string): any; setValue(v: string): any; onChange(cb: (v: string) => any): any }) => any): this;
  }
}

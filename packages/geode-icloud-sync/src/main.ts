import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { SyncPreconditionError } from "geode";
import { FolderSelection, foldersRoot, icloudDriveDir, inspectFolder } from "./folders";
import { createIcloudProvider, type IcloudDiagnostics } from "./provider";

/**
 * Registers the iCloud Drive sync provider. Mac only: the "remote" is a folder
 * in iCloud Drive and the OS does the cross-device syncing, so there is nothing
 * to authenticate and no network access. The remote folder is a per-vault user
 * choice (settings tab), so other devices can bind to the same one.
 */
export default class IcloudSyncPlugin extends Plugin {
  private selection!: FolderSelection;

  async onload(): Promise<void> {
    if (process.platform !== "darwin") {
      console.warn("[icloud-sync] iCloud Drive is only available on macOS; provider not registered.");
      return;
    }
    const vaultId = this.app.vault.root;
    this.selection = new FolderSelection({
      vaultId,
      load: () => this.loadData(),
      save: (data) => this.saveData(data),
      isActive: () => this.app.sync.getActiveProvider()?.id === "icloud",
    });
    this.registerSyncProvider(
      createIcloudProvider({
        PreconditionError: SyncPreconditionError,
        chosenFolder: () => this.selection.chosen(),
        onDiagnostics: (id, diagnostics) => logDiagnostics(id, diagnostics),
      }),
    );
    this.addSettingTab(new IcloudSettingTab(this.app, this, this.selection));
  }
}

class IcloudSettingTab extends PluginSettingTab {
  constructor(app: any, plugin: Plugin, private readonly selection: FolderSelection) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "iCloud Drive" });
    void this.render();
  }

  private async render(): Promise<void> {
    const { containerEl } = this;
    const [effective, existing] = await Promise.all([this.selection.effective(), this.selection.list()]);
    let typed = effective;

    const status = containerEl.createEl("p", { cls: "setting-item-description" });
    const showStatus = async (name: string) => {
      const state = await inspectFolder({}, name);
      status.setText(`Remote: ${foldersRoot({}).replace(icloudDriveDir(), "iCloud Drive")}/${name} (${state === "missing" ? "will be created on first sync" : state === "marked" ? "existing Geode folder" : state === "empty" ? "empty" : "NOT a Geode folder"})`);
    };
    await showStatus(effective);

    const apply = async (value: string) => {
      const result = await this.selection.apply(value);
      if (!result.ok) {
        new Notice(result.message);
        return;
      }
      typed = result.name;
      new Notice(result.changed ? `Remote folder set to "${result.name}" (name was adjusted to be safe).` : `Remote folder set to "${result.name}".`);
      await showStatus(result.name);
      this.display();
    };

    new Setting(containerEl)
      .setName("Remote folder name")
      .setDesc("Folder under iCloud Drive/Geode/ that holds this vault's synced copy. Defaults to the vault's folder name. Use the same name on every Mac. Disconnect sync before changing it.")
      .addText((text) => text.setValue(effective).onChange((value: string) => (typed = value)))
      .addButton((button) => button.setButtonText("Apply").onClick(() => void apply(typed)));

    new Setting(containerEl)
      .setName("Use an existing remote folder")
      .setDesc("Folders in iCloud Drive/Geode/ that already contain a Geode sync marker, e.g. created by another Mac.")
      .addDropdown((dropdown) => {
        dropdown.addOption("", existing.length ? "Select a folder…" : "No existing folders found");
        for (const name of existing) dropdown.addOption(name, name);
        dropdown.setValue(existing.includes(effective) ? effective : "");
        dropdown.onChange((value) => {
          if (value) void apply(value);
        });
      });
  }
}

function logDiagnostics(vaultId: string, d: IcloudDiagnostics): void {
  if (d.unresolvedPlaceholders.length) console.warn(`[icloud-sync] ${vaultId}: ${d.unresolvedPlaceholders.length} file(s) still downloading from iCloud:`, d.unresolvedPlaceholders);
  if (d.conflictCopies.length) console.warn(`[icloud-sync] ${vaultId}: possible iCloud conflict copies withheld from sync; rename or delete them:`, d.conflictCopies);
  if (d.problems.length) console.warn(`[icloud-sync] ${vaultId}:`, d.problems);
}

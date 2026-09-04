import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const manifest = {
  id: "search-component-probe",
  name: "Search Component Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises SearchComponent through the public plugin API.",
  author: "geode",
};

const pluginMain = `
  const {
    AbstractTextComponent,
    BaseComponent,
    Plugin,
    SearchComponent,
    Setting,
    TextAreaComponent,
    TextComponent,
    ValueComponent,
  } = require("obsidian");
  module.exports = class extends Plugin {
    onload() {
      const mount = document.createElement("div");
      mount.id = "search-component-probe";
      document.body.appendChild(mount);
      this.register(() => mount.remove());

      let chainedComponent;
      const search = new SearchComponent(mount)
        .setPlaceholder("Search agents")
        .then((component) => { chainedComponent = component; })
        .onChange(() => { window.__replacedSearchCallback = true; })
        .onChange((value) => {
          window.__searchChanges = [...(window.__searchChanges || []), value];
        });
      search.inputEl.id = "direct-search";
      window.__searchComponent = search;
      window.__searchHierarchy = {
        abstract: search instanceof AbstractTextComponent,
        value: search instanceof ValueComponent,
        base: search instanceof BaseComponent,
        thenReturnsSelf: chainedComponent === search,
      };

      new Setting(mount).addSearch((settingSearch) => {
        settingSearch.inputEl.id = "setting-search";
        window.__settingSearchIsNative = settingSearch instanceof SearchComponent;
      });

      const textMount = document.createElement("div");
      textMount.id = "text-component-mount";
      mount.appendChild(textMount);
      const text = new TextComponent(textMount)
        .setPlaceholder("Text placeholder")
        .onChange((value) => {
          window.__textChanges = [...(window.__textChanges || []), value];
        });
      text.inputEl.id = "text-component-input";
      window.__textComponent = text;

      const textAreaMount = document.createElement("div");
      textAreaMount.id = "textarea-component-mount";
      mount.appendChild(textAreaMount);
      const textArea = new TextAreaComponent(textAreaMount)
        .setPlaceholder("Textarea placeholder")
        .onChange((value) => {
          window.__textAreaChanges = [...(window.__textAreaChanges || []), value];
        });
      textArea.inputEl.id = "textarea-component-input";
      window.__textAreaComponent = textArea;
    }
  };
`;

test("plugin SearchComponent matches the Obsidian interaction contract", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-search-component-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-search-component-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Search component probe\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", manifest.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pluginDir, "main.js"), pluginMain);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([manifest.id]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });
  const consoleErrors: string[] = [];
  try {
    const window = await app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    window.on("pageerror", (error) => consoleErrors.push(String(error)));

    await expect.poll(() => window.evaluate(() => (window as any).app?.pluginManager?.isEnabled?.("search-component-probe"))).toBe(true);
    expect(await window.evaluate(() => (window as any).app.pluginManager.getLoadError("search-component-probe") ?? null)).toBeNull();

    const input = window.locator("#direct-search");
    const container = input.locator("..");
    const clear = container.locator(":scope > .search-input-clear-button");
    expect(await window.evaluate(() => {
      const probeInput = document.querySelector<HTMLInputElement>("#direct-search")!;
      const probeContainer = probeInput.parentElement!;
      const probeClear = probeContainer.querySelector<HTMLElement>(":scope > .search-input-clear-button")!;
      return {
        containerClass: probeContainer.classList.contains("search-input-container"),
        inputClass: probeInput.className,
        inputType: probeInput.type,
        placeholder: probeInput.placeholder,
        clearLabel: probeClear.getAttribute("aria-label"),
        children: probeContainer.children.length,
        hierarchy: (window as any).__searchHierarchy,
        settingSearchIsNative: (window as any).__settingSearchIsNative,
      };
    })).toEqual({
      containerClass: true,
      inputClass: "search-input",
      inputType: "search",
      placeholder: "Search agents",
      clearLabel: "Clear search",
      children: 2,
      hierarchy: { abstract: true, value: true, base: true, thenReturnsSelf: true },
      settingSearchIsNative: true,
    });

    await window.evaluate(() => {
      (window as any).__searchComponent.setValue("programmatic");
    });
    await expect(input).toHaveValue("programmatic");
    await expect(clear).toBeVisible();
    expect(await window.evaluate(() => ({
      changes: (window as any).__searchChanges || [],
      replacedCallbackFired: Boolean((window as any).__replacedSearchCallback),
      value: (window as any).__searchComponent.getValue(),
    }))).toEqual({ changes: [], replacedCallbackFired: false, value: "programmatic" });

    await input.fill("agents");
    expect(await window.evaluate(() => (window as any).__searchChanges)).toEqual(["agents"]);
    await clear.click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(clear).toBeHidden();
    expect(await window.evaluate(() => (window as any).__searchChanges)).toEqual(["agents", ""]);

    await input.focus();
    await expect(input).toBeFocused();
    await input.evaluate((element) => element.blur());
    await expect(input).not.toBeFocused();

    await window.evaluate(() => {
      (window as any).__searchComponent.setValue("locked").setDisabled(true);
    });
    await expect(input).toBeDisabled();
    expect(await window.evaluate(() => (window as any).__searchComponent.disabled)).toBe(true);
    await expect(clear).toBeHidden();
    await clear.evaluate((element: HTMLElement) => element.click());
    await expect(input).toHaveValue("locked");
    expect(await window.evaluate(() => (window as any).__searchChanges)).toEqual(["agents", ""]);

    await window.evaluate(() => {
      (window as any).__searchComponent.setDisabled(false);
    });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("locked");
    await expect(clear).toBeVisible();
    expect(await window.evaluate(() => (window as any).__searchComponent.disabled)).toBe(false);

    const textInput = window.locator("#text-component-input");
    expect(await textInput.evaluate((element) => element.parentElement?.id)).toBe("text-component-mount");
    await expect(textInput).toHaveAttribute("type", "text");
    await expect(textInput).toHaveAttribute("placeholder", "Text placeholder");
    await window.evaluate(() => {
      (window as any).__textComponent.setValue("silent text");
    });
    await expect(textInput).toHaveValue("silent text");
    expect(await window.evaluate(() => (window as any).__textChanges || [])).toEqual([]);
    await textInput.fill("typed text");
    expect(await window.evaluate(() => (window as any).__textChanges)).toEqual(["typed text"]);
    await window.evaluate(() => {
      (window as any).__textComponent.setDisabled(true);
    });
    await expect(textInput).toBeDisabled();

    const textAreaInput = window.locator("#textarea-component-input");
    expect(await textAreaInput.evaluate((element) => element.parentElement?.id)).toBe("textarea-component-mount");
    await expect(textAreaInput).toHaveAttribute("placeholder", "Textarea placeholder");
    await window.evaluate(() => {
      (window as any).__textAreaComponent.setValue("silent textarea");
    });
    await expect(textAreaInput).toHaveValue("silent textarea");
    expect(await window.evaluate(() => (window as any).__textAreaChanges || [])).toEqual([]);
    await textAreaInput.fill("typed textarea");
    expect(await window.evaluate(() => (window as any).__textAreaChanges)).toEqual(["typed textarea"]);
    await window.evaluate(() => {
      (window as any).__textAreaComponent.setDisabled(true);
    });
    await expect(textAreaInput).toBeDisabled();

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

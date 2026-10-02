import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "view-workspaceleaf-contract-probe",
  name: "View and WorkspaceLeaf Contract Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises existing View and WorkspaceLeaf compatibility contracts.",
  author: "geode",
};

/**
 * A real CommonJS plugin fixture. Keeping the assertions behind
 * `require('obsidian')` proves the public plugin module and the Electron host
 * together, rather than importing Geode's implementation into the test.
 */
const MAIN_JS = `
  const obsidian = require('obsidian');
  const VIEW_TYPE = 'view-workspaceleaf-contract-probe';
  const REPLACEMENT_TYPE = 'view-workspaceleaf-contract-replacement';

  const probe = window.__viewWorkspaceLeafContractProbe = {
    lifecycle: [],
    stateCalls: [],
    gates: {},
  };

  function makeGate(name) {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    probe.gates[name] = { promise, release };
  }

  makeGate('open');
  makeGate('state');
  makeGate('close');
  makeGate('replacementOpen');

  class ProbeView extends obsidian.View {
    constructor(leaf) {
      super(leaf);
      this.icon = 'panel-top';
      this.savedState = { revision: 0 };
      probe.constructedView = this;
      probe.construction = {
        isView: this instanceof obsidian.View,
        leafIdentity: this.leaf === leaf,
        appIdentity: this.app === leaf.app,
        containerIsElement: this.containerEl instanceof HTMLElement,
        containerClass: this.containerEl.className,
        icon: this.icon,
        navigation: this.navigation,
        scope: this.scope,
      };
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return 'View Contract Probe'; }
    getState() { return { ...this.savedState }; }
    async setState(state, result) {
      probe.lifecycle.push('state-start');
      await probe.gates.state.promise;
      this.savedState = { ...state };
      probe.stateCalls.push({ state: this.getState(), result, sameView: this === probe.constructedView });
      probe.lifecycle.push('state-end');
    }
    async onOpen() {
      probe.lifecycle.push('open-start');
      await probe.gates.open.promise;
      this.containerEl.createDiv({ cls: 'view-contract-probe-body', text: 'view-opened' });
      probe.lifecycle.push('open-end');
    }
    async onClose() {
      probe.lifecycle.push('close-start');
      await probe.gates.close.promise;
      probe.lifecycle.push('close-end');
    }
  }

  class ReplacementView extends obsidian.View {
    getViewType() { return REPLACEMENT_TYPE; }
    getDisplayText() { return 'Replacement Probe'; }
    async onOpen() {
      probe.lifecycle.push('replacement-open-start');
      await probe.gates.replacementOpen.promise;
      this.containerEl.createDiv({ cls: 'replacement-probe-body', text: 'replacement-opened' });
      probe.lifecycle.push('replacement-open-end');
    }
  }

  probe.ProbeView = ProbeView;

  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      this.registerView(VIEW_TYPE, (leaf) => new ProbeView(leaf));
      this.registerView(REPLACEMENT_TYPE, (leaf) => new ReplacementView(leaf));
      probe.loaded = true;
    }
  };
`;

function makeVault(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-view-contract-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-view-contract-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# View contract\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", MANIFEST.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([MANIFEST.id]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultDir],
    lastVault: vaultDir,
  }));
  return { vaultDir, userDataDir };
}

test("a CommonJS plugin observes View and WorkspaceLeaf lifecycle, state, display, icon, and pinning contracts", async () => {
  const { vaultDir, userDataDir } = makeVault();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const capturedRuntimeErrors: string[] = [];

  try {
    app = await electron.launch({
      args: [repoRoot, `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
    });
    const window = await app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") capturedRuntimeErrors.push(message.text());
    });
    window.on("pageerror", (error) => capturedRuntimeErrors.push(String(error)));
    await window.waitForFunction(() =>
      (window as any).app?.workspace?.layoutReady === true
      && (window as any).__viewWorkspaceLeafContractProbe?.loaded === true
    );

    const initial = await window.evaluate(() => {
      const workspace = (window as any).app.workspace;
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      const leaf = workspace.getLeaf(true);
      const view = new probe.ProbeView(leaf);
      probe.leaf = leaf;
      probe.view = view;

      const observed = {
        construction: probe.construction,
        viewType: view.getViewType(),
        displayText: view.getDisplayText(),
        icon: view.getIcon(),
        state: view.getState(),
        ephemeral: view.getEphemeralState(),
      };

      const ephemeralInput = { cursor: 3, mode: "preview" };
      view.setEphemeralState(ephemeralInput);
      ephemeralInput.cursor = 99;

      probe.openResolved = false;
      probe.openPromise = leaf.open(view).then((opened: unknown) => {
        probe.openResolved = true;
        probe.openReturnedSameView = opened === view;
      });
      return observed;
    });

    expect(initial.construction).toEqual({
      isView: true,
      leafIdentity: true,
      appIdentity: true,
      containerIsElement: true,
      containerClass: "workspace-leaf-content view-content-host",
      icon: "panel-top",
      navigation: false,
      scope: null,
    });
    expect(initial).toMatchObject({
      viewType: "view-workspaceleaf-contract-probe",
      displayText: "View Contract Probe",
      icon: "panel-top",
      state: { revision: 0 },
      ephemeral: {},
    });

    await expect.poll(() => window.evaluate(() => [
      (window as any).__viewWorkspaceLeafContractProbe.lifecycle,
      (window as any).__viewWorkspaceLeafContractProbe.openResolved,
    ])).toEqual([["open-start"], false]);
    await expect(window.locator(".view-contract-probe-body")).toHaveCount(0);

    await window.evaluate(async () => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      probe.gates.open.release();
      await probe.openPromise;
    });
    const afterOpen = await window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      const { leaf, view } = probe;
      return {
        returnedSameView: probe.openReturnedSameView,
        leafViewIdentity: leaf.view === view,
        leafDisplayText: leaf.getDisplayText(),
        ephemeral: view.getEphemeralState(),
        lifecycle: [...probe.lifecycle],
        containerConnected: view.containerEl.isConnected,
        bodyText: view.containerEl.querySelector(".view-contract-probe-body")?.textContent,
      };
    });
    expect(afterOpen).toEqual({
      returnedSameView: true,
      leafViewIdentity: true,
      leafDisplayText: "View Contract Probe",
      ephemeral: { cursor: 3, mode: "preview" },
      lifecycle: ["open-start", "open-end"],
      containerConnected: true,
      bodyText: "view-opened",
    });

    await window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      probe.setStateResolved = false;
      probe.setStatePromise = probe.leaf.setViewState({
        type: "view-workspaceleaf-contract-probe",
        active: true,
        state: { revision: 1, label: "saved" },
      }).then(() => {
        probe.setStateResolved = true;
      });
    });
    await expect.poll(() => window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      return {
        lifecycle: probe.lifecycle,
        resolved: probe.setStateResolved,
        state: probe.view.getState(),
      };
    })).toEqual({
      lifecycle: ["open-start", "open-end", "state-start"],
      resolved: false,
      state: { revision: 0 },
    });

    await window.evaluate(async () => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      probe.gates.state.release();
      await probe.setStatePromise;
    });
    const afterSetViewState = await window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      const { leaf, view } = probe;
      return {
        sameView: leaf.view === view,
        viewState: leaf.getViewState(),
        stateCalls: [...probe.stateCalls],
        lifecycle: [...probe.lifecycle],
      };
    });
    expect(afterSetViewState).toEqual({
      sameView: true,
      viewState: {
        type: "view-workspaceleaf-contract-probe",
        state: { revision: 1, label: "saved" },
      },
      stateCalls: [{
        state: { revision: 1, label: "saved" },
        result: {},
        sameView: true,
      }],
      lifecycle: ["open-start", "open-end", "state-start", "state-end"],
    });

    const pinAndIcon = await window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      const { leaf, view } = probe;
      leaf.setPinned(true);
      const afterSetPinned = { pinned: leaf.pinned, sameView: leaf.view === view };
      leaf.togglePinned();
      const afterToggleOff = { pinned: leaf.pinned, sameView: leaf.view === view };
      leaf.togglePinned();
      const afterToggleOn = { pinned: leaf.pinned, sameView: leaf.view === view };

      const beforeReplacement = {
        tabClass: leaf.tabEl.className,
        tabLabel: leaf.tabEl.getAttribute("aria-label"),
        tabTitle: leaf.tabEl.querySelector(".workspace-tab-header-inner-title")?.textContent,
        iconData: leaf.tabEl.querySelector(".workspace-tab-header-inner-icon")?.getAttribute("data-icon"),
        iconSvgClass: leaf.tabEl.querySelector(".workspace-tab-header-inner-icon svg")?.getAttribute("class"),
      };
      return {
        afterSetPinned,
        afterToggleOff,
        afterToggleOn,
        beforeReplacement,
      };
    });
    expect(pinAndIcon.afterSetPinned).toEqual({ pinned: true, sameView: true });
    expect(pinAndIcon.afterToggleOff).toEqual({ pinned: false, sameView: true });
    expect(pinAndIcon.afterToggleOn).toEqual({ pinned: true, sameView: true });
    expect(pinAndIcon.beforeReplacement.tabClass).toContain("mod-pinned");
    expect(pinAndIcon.beforeReplacement.tabLabel).toBe("View Contract Probe");
    expect(pinAndIcon.beforeReplacement.tabTitle).toBe("View Contract Probe");
    expect(pinAndIcon.beforeReplacement.iconData).toBe("panel-top");
    expect(pinAndIcon.beforeReplacement.iconSvgClass).toMatch(/\blucide-panel-top\b/);

    await window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      probe.replacementResolved = false;
      probe.replacementPromise = probe.leaf.setViewState({
        type: "view-workspaceleaf-contract-replacement",
        active: true,
      }).then(() => {
        probe.replacementResolved = true;
      });
    });
    await expect.poll(() => window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      return { lifecycle: probe.lifecycle, resolved: probe.replacementResolved };
    })).toEqual({
      lifecycle: ["open-start", "open-end", "state-start", "state-end", "close-start"],
      resolved: false,
    });
    await expect(window.locator(".view-contract-probe-body")).toHaveText("view-opened");
    await expect(window.locator(".replacement-probe-body")).toHaveCount(0);

    await window.evaluate(() => {
      (window as any).__viewWorkspaceLeafContractProbe.gates.close.release();
    });
    await expect.poll(() => window.evaluate(() => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      return { lifecycle: probe.lifecycle, resolved: probe.replacementResolved };
    })).toEqual({
      lifecycle: [
        "open-start", "open-end", "state-start", "state-end",
        "close-start", "close-end", "replacement-open-start",
      ],
      resolved: false,
    });
    await expect(window.locator(".replacement-probe-body")).toHaveCount(0);

    await window.evaluate(async () => {
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      probe.gates.replacementOpen.release();
      await probe.replacementPromise;
    });
    const lifecycleAfterReplacement = await window.evaluate(
      () => [...(window as any).__viewWorkspaceLeafContractProbe.lifecycle],
    );
    expect(lifecycleAfterReplacement).toEqual([
      "open-start", "open-end", "state-start", "state-end",
      "close-start", "close-end", "replacement-open-start", "replacement-open-end",
    ]);

    const activeTab = window.locator(".workspace-split.mod-root .workspace-tab-header.is-active");
    await expect(activeTab).toHaveAttribute("aria-label", "Replacement Probe");
    await expect(window.locator(".replacement-probe-body")).toHaveText("replacement-opened");
    await expect(window.locator(".view-contract-probe-body")).toHaveCount(0);
    // Listener installation follows firstWindow(), so this covers the exercised
    // contract flow, not errors emitted during Electron's earliest startup.
    expect(capturedRuntimeErrors, capturedRuntimeErrors.join("\n")).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

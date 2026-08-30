import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

describe("iOS native smoke proof", () => {
  it("keeps the generated Capacitor SPM scaffold complete", () => {
    const sourcePath = path.join(root, "ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift");
    const debugConfigPath = path.join(root, "ios/debug.xcconfig");
    const appDelegatePath = path.join(root, "ios/App/App/AppDelegate.swift");

    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf8").trim()).toBe("public let isCapacitorApp = true");
    expect(fs.existsSync(debugConfigPath)).toBe(true);
    expect(fs.readFileSync(debugConfigPath, "utf8").trim()).toBe("CAPACITOR_DEBUG = true");
    expect(fs.existsSync(appDelegatePath)).toBe(true);
    const appDelegate = fs.readFileSync(appDelegatePath, "utf8");
    expect(appDelegate).toContain("@UIApplicationMain");
    expect(appDelegate).toContain("config.delegateClass = SceneDelegate.self");

    for (const relativePath of [
      "ios/App/App/Base.lproj/Main.storyboard",
      "ios/App/App/Base.lproj/LaunchScreen.storyboard",
      "ios/App/App/Assets.xcassets/Contents.json",
      "ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json",
      "ios/App/App/Assets.xcassets/Splash.imageset/Contents.json",
    ]) {
      expect(fs.existsSync(path.join(root, relativePath)), relativePath).toBe(true);
    }
  });

  it("keeps lifecycle proof logging out of release builds", () => {
    const source = fs.readFileSync(path.join(root, "ios/App/App/SceneDelegate.swift"), "utf8");
    for (const event of ["background", "foreground", "active"]) {
      expect(source).toMatch(new RegExp(`#if DEBUG\\s+print\\("GEODE_NATIVE_LIFECYCLE ${event}"\\)\\s+#endif`));
    }
  });

  it("polls persistence within a bound and retries only the explicit preload sentinel", () => {
    const source = fs.readFileSync(path.join(root, "ios/App/App/GeodeBridgeViewController.swift"), "utf8");

    expect(source).not.toContain("setTimeout(resolve, 1800)");
    expect(source).toContain("for (let persistenceAttempt = 0; persistenceAttempt < 50; persistenceAttempt += 1)");
    expect(source).toContain("setTimeout(resolve, 100)");
    expect(source).toContain('(value as? String) == "not-ready"');
    expect(source).not.toContain('if (!file) return "missing-file"');
    expect(source).toContain('if (!file) return "not-ready"');
    expect(source).toContain("case .failure(let error):\n                NSLog(");
    expect(source).toContain('print("GEODE_NATIVE_SMOKE_ERROR');
    const smokeFailureBranch = source.slice(
      source.lastIndexOf("case .failure(let error):"),
      source.lastIndexOf("#endif"),
    );
    expect(smokeFailureBranch).not.toContain("runNativeSmoke");
    expect(source).toContain('debugExternalVaultProbe({ mode: "edit" })');
    expect(source).toContain('debugExternalVaultProbe({ mode: "verify" })');
  });

  it("registers the first-party managed vault plugin through the Capacitor 8 instance API", () => {
    const bridge = fs.readFileSync(path.join(root, "ios/App/App/GeodeBridgeViewController.swift"), "utf8");
    const plugin = fs.readFileSync(path.join(root, "ios/App/App/GeodeManagedVaultPlugin.swift"), "utf8");

    expect(bridge).toContain("override func capacitorDidLoad()");
    expect(bridge).toContain("bridge?.registerPluginInstance(managedVaultPlugin)");
    expect(plugin).toContain("CAPPlugin, CAPBridgedPlugin");
    expect(plugin).toContain('public let jsName = "GeodeManagedVault"');
    for (const method of ["openVault", "list", "read", "readBinary", "write", "mkdir", "trash", "rename", "exists", "settleMutation"]) {
      expect(plugin).toContain(`CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`);
      expect(plugin).toContain(`@objc func ${method}(_ call: CAPPluginCall)`);
    }
  });

  it("hosts plugins from the active native vault with a bounded atomic file-set transaction", () => {
    const plugin = fs.readFileSync(path.join(root, "ios/App/App/GeodeManagedVaultPlugin.swift"), "utf8");
    for (const method of ["listPluginIds", "listThemes", "readPluginFile", "replacePluginFiles"]) {
      expect(plugin).toContain(`CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`);
      expect(plugin).toContain(`@objc func ${method}(_ call: CAPPluginCall)`);
    }
    expect(plugin).toContain("pluginBridgeLimit = 16 * 1024 * 1024");
    expect(plugin).toContain("atomicReplacePluginFiles");
    expect(plugin).toContain("expectedManifest");
    expect(plugin).toContain("else if self.fileManager.fileExists(atPath: styleURL.path)");
    expect(plugin).toContain("pluginRollbackExact");
    expect(plugin).toContain("pluginEntrypointBase64");
    expect(plugin).not.toContain('call.resolve(["root"');
  });

  it("implements an opaque security-scoped File Provider registry with balanced access", () => {
    const plugin = fs.readFileSync(path.join(root, "ios/App/App/GeodeManagedVaultPlugin.swift"), "utf8");

    for (const method of ["chooseExternalVault", "reconnectVault", "describeVault", "checkVault", "getRecentVaults", "getLaunchVault", "closeVault"]) {
      expect(plugin).toContain(`CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`);
      expect(plugin).toContain(`@objc func ${method}(_ call: CAPPluginCall)`);
    }
    expect(plugin).toContain("UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)");
    expect(plugin).toContain("documentPickerWasCancelled");
    expect(plugin).toContain("bookmarkData(options: .minimalBookmark");
    expect(plugin).toContain("bookmarkDataIsStale: &isStale");
    expect(plugin).toContain("startAccessingSecurityScopedResource()");
    expect(plugin).toContain("stopAccessingSecurityScopedResource()");
    expect(plugin).toContain("FileProtectionType.completeUntilFirstUserAuthentication");
    expect(plugin).toContain("VAULT_PERMISSION_REVOKED");
    expect(plugin).toContain("VAULT_MISSING");
    expect(plugin).toContain("VAULT_UNAVAILABLE");
    expect(plugin).toContain("CONTENT_UNAVAILABLE");
    expect(plugin).not.toContain("withSecurityScope");
    expect(plugin).not.toContain('call.resolve(["url"');
    expect(plugin).not.toContain('call.resolve(["bookmark"');
    expect(plugin).toContain('CAPPluginMethod(name: "debugExternalVaultProbe"');
    expect(plugin).toContain("debugExternalVaultProbe(_ call: CAPPluginCall)");
    expect(plugin).toContain("accessBalanced");
    expect(plugin).toContain("coldReopenId");
    expect(plugin).toContain("missingCode");
    expect(plugin).toContain("revokedCode");
    expect(plugin).toContain("siblingEscapeCode");
    expect(plugin).toContain("registryIdentity");
    expect(plugin).toContain("providerIdentity");
    expect(plugin).toContain("rootResourceIdentity");
    expect(plugin).toContain("copiedMarkerNewId");
    expect(plugin).toContain("copiedMarkerReconnectCode");
    expect(plugin).toContain("originalMovePreservedId");
  });

  it("releases security-scoped access when the owning scene disconnects", () => {
    const scene = fs.readFileSync(path.join(root, "ios/App/App/SceneDelegate.swift"), "utf8");
    const bridge = fs.readFileSync(path.join(root, "ios/App/App/GeodeBridgeViewController.swift"), "utf8");
    const plugin = fs.readFileSync(path.join(root, "ios/App/App/GeodeManagedVaultPlugin.swift"), "utf8");

    expect(bridge).toContain("private let managedVaultPlugin = GeodeManagedVaultPlugin()")
    expect(bridge).toContain("bridge?.registerPluginInstance(managedVaultPlugin)")
    expect(bridge).toContain("func releaseVaultAccess()")
    expect(plugin).toContain("func releaseVaultAccess()")
    expect(scene).toContain("func sceneDidDisconnect(_ scene: UIScene)")
    expect(scene).toContain("(window?.rootViewController as? GeodeBridgeViewController)?.releaseVaultAccess()")
  });

  it("enforces coordinated managed-vault safety and coded failures in native code", () => {
    const plugin = fs.readFileSync(path.join(root, "ios/App/App/GeodeManagedVaultPlugin.swift"), "utf8");

    expect(plugin).toContain("NSFileCoordinator");
    expect(plugin).toContain("private func coordinatedDirectoryEntries")
    expect(plugin).toContain("private func coordinatedCreateDirectory")
    expect(plugin).toContain("private func coordinatedExists")
    expect(plugin).toContain("writingItemAt: source")
    expect(plugin).toContain("writingItemAt: destination")
    expect(plugin).toContain("injectDestinationDelay")
    expect(plugin).toContain("injectDestinationCollision")
    expect(plugin).toContain("injectCancellation")
    expect(plugin).toContain("renameDestinationCollisionCode")
    expect(plugin).toContain("renameCancellationCode")
    expect(plugin).toContain("trashDestinationCollisionCode")
    expect(plugin).toContain("trashCancellationCode")
    expect(plugin).toContain(".geode-trash");
    expect(plugin).toContain("resolvingSymlinksInPath()");
    expect(plugin).toContain("INVALID_PATH");
    expect(plugin).toContain("NOT_FOUND");
    expect(plugin).toContain("COLLISION");
    expect(plugin).toContain("STORAGE_UNAVAILABLE");
    expect(plugin).toContain("IO_FAILURE");
    expect(plugin).toContain("injectPostSwapFailure");
    expect(plugin).toContain("originalPath");
    expect(plugin).toContain('path.contains("\\\\")');
    expect(plugin).toContain("atomicOriginalBytes");
    expect(plugin).toContain("atomicArtifacts");
    expect(plugin).toContain("trashPayloadBase64");
    expect(plugin).toContain("listedTrash");
    expect(plugin).toContain("symlinkEscapeCode");
    expect(plugin).toContain("binaryLimitCode");
    expect(plugin).not.toContain('call.resolve(["root": vaultRoot.path');
  });

  it("declares Apple's app-container file timestamp reason", () => {
    const manifest = fs.readFileSync(path.join(root, "ios/App/App/PrivacyInfo.xcprivacy"), "utf8");

    expect(manifest).toContain("NSPrivacyAccessedAPICategoryFileTimestamp");
    expect(manifest).toContain("C617.1");
  });
});

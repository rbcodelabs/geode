import Capacitor
import WebKit

final class GeodeBridgeViewController: CAPBridgeViewController {
    private let managedVaultPlugin = GeodeManagedVaultPlugin()

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let webView = super.webView(with: frame, configuration: configuration)
        webView.scrollView.keyboardDismissMode = .onDrag
        return webView
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        refreshNativeSafeAreaCSSVariables()
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains(Self.editArgument) || arguments.contains(Self.verifyArgument) else { return }
        runNativeSmoke(verifyOnly: arguments.contains(Self.verifyArgument))
#endif
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        updateNativeSafeAreaCSSVariables()
    }

    private func updateNativeSafeAreaCSSVariables() {
        let top = view.safeAreaInsets.top
        let bottom = view.safeAreaInsets.bottom
        webView?.evaluateJavaScript("document.documentElement.style.setProperty('--geode-native-safe-area-top', '\(top)px'); document.documentElement.style.setProperty('--geode-native-safe-area-bottom', '\(bottom)px')")
    }

    private func refreshNativeSafeAreaCSSVariables(attempt: Int = 0) {
        updateNativeSafeAreaCSSVariables()
        guard attempt < 12 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.refreshNativeSafeAreaCSSVariables(attempt: attempt + 1)
        }
    }

    override func capacitorDidLoad() {
#if DEBUG
        managedVaultPlugin.prepareManagedCoreAcceptanceFixtureIfRequested()
#endif
        bridge?.registerPluginInstance(managedVaultPlugin)
#if DEBUG
        installManagedCoreAcceptanceVerifierIfRequested()
#endif
    }

    func releaseVaultAccess() {
        managedVaultPlugin.releaseVaultAccess()
    }

#if DEBUG
    private static var acceptanceMode: String? {
#if targetEnvironment(simulator)
        let process = ProcessInfo.processInfo
        let environment = process.environment["GEODE_IOS_MVP_ACCEPTANCE"]
        if environment == "seed", process.arguments.contains("--geode-ios-mvp-acceptance-seed") { return "seed" }
        if environment == "verify", process.arguments.contains("--geode-ios-mvp-acceptance-verify") { return "verify" }
        if environment == "legacy", process.arguments.contains("--geode-ios-mvp-acceptance-legacy") { return "legacy" }
#endif
        return nil
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        if Self.acceptanceMode != nil {
            let script = """
            (() => {
              const errors = [];
              const append = (kind, value) => {
                if (errors.length >= 20) return;
                let message;
                try { message = typeof value === "string" ? value : value?.message ?? String(value); }
                catch { message = "unserializable error"; }
                errors.push({ kind, message: message.slice(0, 500) });
              };
              Object.defineProperty(window, "__geodeNativeAcceptanceErrors", { value: errors, configurable: false });
              window.addEventListener("error", event => append("error", event.error ?? event.message));
              window.addEventListener("unhandledrejection", event => append("unhandledrejection", event.reason));
              const originalConsoleError = console.error.bind(console);
              console.error = (...values) => {
                append("console.error", values.map(value => {
                  try { return typeof value === "string" ? value : JSON.stringify(value); }
                  catch { return String(value); }
                }).join(" "));
                originalConsoleError(...values);
              };
            })();
            """
            configuration.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
        return configuration
    }

    private func installManagedCoreAcceptanceVerifierIfRequested() {
        guard Self.acceptanceMode != nil else { return }
        let label = UILabel(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        label.text = "Native managed-core verifier"
        label.font = .systemFont(ofSize: 1)
        label.textColor = .clear
        label.backgroundColor = .clear
        label.isUserInteractionEnabled = false
        label.isAccessibilityElement = true
        label.accessibilityIdentifier = "native-managed-core-verifier"
        label.accessibilityLabel = "Native managed-core verifier"
        view.addSubview(label)
        refreshManagedCoreAcceptanceVerifier(label)
    }

    private func refreshManagedCoreAcceptanceVerifier(_ label: UILabel) {
        guard Self.acceptanceMode != nil else { return }
        managedVaultPlugin.managedCoreAcceptanceSnapshot { [weak self, weak label] result in
            DispatchQueue.main.async {
                guard let self, let label else { return }
                switch result {
                case .success(var snapshot):
                    snapshot["safeAreaTop"] = Double(self.view.safeAreaInsets.top)
                    snapshot["safeAreaBottom"] = Double(self.view.safeAreaInsets.bottom)
                    self.collectManagedCoreJavaScriptState { javascript in
                        snapshot["javascript"] = javascript
                        if let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]),
                           let value = String(data: data, encoding: .utf8) {
                            label.accessibilityValue = value
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak label] in
                            if let label { self?.refreshManagedCoreAcceptanceVerifier(label) }
                        }
                    }
                case .failure(let error):
                    label.accessibilityValue = "{\"nativeErrors\":[\"\(error.localizedDescription)\"]}"
                }
            }
        }
    }

    private func collectManagedCoreJavaScriptState(_ completion: @escaping (JSObject) -> Void) {
        let script = """
        return JSON.stringify({
          ready: Boolean(window.app && window.hostServices),
          runtime: window.hostServices?.runtime?.runtime ?? null,
          activeFile: window.app?.workspace?.getActiveFile?.()?.path ?? "",
          editor: window.app?.workspace?.activeLeaf?.view?.editor?.state?.doc?.toString?.() ?? "",
          editorFocused: document.activeElement?.classList?.contains("cm-content") ?? false,
          activeElementInClosedDrawer: Boolean(
            document.activeElement?.closest?.(".workspace-sidebar:not(.is-mobile-drawer-open)")
          ),
          activeElementLabel: document.activeElement?.getAttribute?.("aria-label")
            ?? document.activeElement?.className
            ?? document.activeElement?.tagName
            ?? "",
          cssSafeAreaTop: getComputedStyle(document.documentElement).getPropertyValue("--geode-native-safe-area-top"),
          rightDrawerTop: document.querySelector(".workspace-sidebar.mod-right")?.getBoundingClientRect?.().top ?? null,
          settingsRect: (() => {
            const rect = document.querySelector(".modal.mod-settings")?.getBoundingClientRect?.();
            return rect ? { top: rect.top, bottom: rect.bottom } : null;
          })(),
          activeHeaderTop: (() => {
            const headers = [...document.querySelectorAll(".markdown-view > .view-header")];
            const rect = headers.map(header => header.getBoundingClientRect()).find(value => value.width > 0 && value.height > 0);
            return rect?.top ?? null;
          })(),
          documentScrollY: window.scrollY,
          visualViewportTop: window.visualViewport?.offsetTop ?? 0,
          leftDrawerOpen: document.querySelector(".workspace-sidebar.mod-left")?.classList.contains("is-mobile-drawer-open") ?? false,
          mobileNavigationInert: document.querySelector(".mobile-navigation")?.inert ?? false,
          mobileNavigationHitTarget: (() => {
            const button = document.querySelector('.mobile-navigation [aria-label="New note"]');
            const rect = button?.getBoundingClientRect?.();
            if (!rect) return "";
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit?.closest?.("[aria-label]")?.getAttribute?.("aria-label") ?? hit?.className ?? "";
          })(),
          mobileNavigationLayout: (() => {
            const actions = [...document.querySelectorAll(".mobile-navigation-action")];
            const rects = actions.map(action => action.getBoundingClientRect());
            return {
              labels: actions.map(action => action.getAttribute("aria-label") ?? ""),
              allVisible: actions.every((action, index) => {
                const style = getComputedStyle(action);
                const rect = rects[index];
                return style.display !== "none" && style.visibility !== "hidden"
                  && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
              }),
              minLeft: rects.length ? Math.min(...rects.map(rect => rect.left)) : -1,
              maxRight: rects.length ? Math.max(...rects.map(rect => rect.right)) : -1,
              minHeight: rects.length ? Math.min(...rects.map(rect => rect.height)) : -1
            };
          })(),
          innerWidth: window.innerWidth,
          leftDrawerRect: (() => {
            const rect = document.querySelector(".workspace-sidebar.mod-left")?.getBoundingClientRect?.();
            return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
          })(),
          welcomeRowRect: (() => {
            const rect = document.querySelector('[aria-label="Open file Welcome.md"]')?.getBoundingClientRect?.();
            return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
          })(),
          errors: window.__geodeNativeAcceptanceErrors ?? []
        });
        """
        webView?.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                guard let string = value as? String,
                      let data = string.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let ready = object["ready"] as? Bool else {
                    completion([
                        "ready": false,
                        "snapshotError": "JavaScript snapshot was not valid JSON: \(String(describing: value))"
                    ])
                    return
                }
                let errors: JSArray = (object["errors"] as? [[String: Any]] ?? []).map { error in
                    [
                        "kind": error["kind"] as? String ?? "unknown",
                        "message": error["message"] as? String ?? "unknown"
                    ] as JSObject
                }
                let settingsObject = object["settingsRect"] as? [String: Any]
                let settingsRect: JSObject = [
                    "top": settingsObject?["top"] as? Double ?? -1,
                    "bottom": settingsObject?["bottom"] as? Double ?? -1
                ]
                let activeHeaderTop = object["activeHeaderTop"] as? Double ?? -1
                let leftDrawerObject = object["leftDrawerRect"] as? [String: Any]
                let welcomeRowObject = object["welcomeRowRect"] as? [String: Any]
                let mobileNavigationObject = object["mobileNavigationLayout"] as? [String: Any]
                let mobileNavigationLabels: JSArray = mobileNavigationObject?["labels"] as? [String] ?? []
                completion([
                    "ready": ready,
                    "runtime": object["runtime"] as? String ?? "",
                    "activeFile": object["activeFile"] as? String ?? "",
                    "editor": object["editor"] as? String ?? "",
                    "editorFocused": object["editorFocused"] as? Bool ?? false,
                    "activeElementInClosedDrawer": object["activeElementInClosedDrawer"] as? Bool ?? false,
                    "activeElementLabel": object["activeElementLabel"] as? String ?? "",
                    "cssSafeAreaTop": object["cssSafeAreaTop"] as? String ?? "",
                    "rightDrawerTop": object["rightDrawerTop"] as? Double ?? -1,
                    "settingsRect": settingsRect,
                    "activeHeaderTop": activeHeaderTop,
                    "documentScrollY": object["documentScrollY"] as? Double ?? -1,
                    "visualViewportTop": object["visualViewportTop"] as? Double ?? -1,
                    "leftDrawerOpen": object["leftDrawerOpen"] as? Bool ?? false,
                    "mobileNavigationInert": object["mobileNavigationInert"] as? Bool ?? false,
                    "mobileNavigationHitTarget": object["mobileNavigationHitTarget"] as? String ?? "",
                    "mobileNavigationLayout": [
                        "labels": mobileNavigationLabels,
                        "allVisible": mobileNavigationObject?["allVisible"] as? Bool ?? false,
                        "minLeft": mobileNavigationObject?["minLeft"] as? Double ?? -1,
                        "maxRight": mobileNavigationObject?["maxRight"] as? Double ?? -1,
                        "minHeight": mobileNavigationObject?["minHeight"] as? Double ?? -1
                    ] as JSObject,
                    "innerWidth": object["innerWidth"] as? Double ?? -1,
                    "leftDrawerRect": [
                        "left": leftDrawerObject?["left"] as? Double ?? -1,
                        "right": leftDrawerObject?["right"] as? Double ?? -1,
                        "width": leftDrawerObject?["width"] as? Double ?? -1
                    ] as JSObject,
                    "welcomeRowRect": [
                        "left": welcomeRowObject?["left"] as? Double ?? -1,
                        "right": welcomeRowObject?["right"] as? Double ?? -1,
                        "width": welcomeRowObject?["width"] as? Double ?? -1
                    ] as JSObject,
                    "errors": errors
                ])
            case .failure(let error): completion(["ready": false, "snapshotError": error.localizedDescription])
            }
        }
    }

    private static let editArgument = "--geode-native-smoke-edit"
    private static let verifyArgument = "--geode-native-smoke-verify"

    private func runNativeSmoke(verifyOnly: Bool, attempt: Int = 0) {
        let marker = "# Native WKWebView proof\\n\\nEdited through Geode CodeMirror"
        let script = verifyOnly ? """
            try {
            if (!window.app || !window.hostServices || !window.Capacitor?.Plugins?.GeodeManagedVault) return "not-ready";
            if (window.app.vault.root.startsWith("external://")) {
                const launchId = window.app.vault.root;
                const providerFile = window.app.vault.getFileByPath("Notes/Proof.md");
                if (!providerFile) return "not-ready";
                await window.app.openFile(providerFile, false);
                const providerEditor = window.app.workspace.activeLeaf?.view?.editor;
                const external = await window.Capacitor.Plugins.GeodeManagedVault.debugExternalVaultProbe({ mode: "verify" });
                return JSON.stringify({ status: external.status === "restored" && external.coldReopenId === launchId && providerEditor?.state.doc.toString() === "provider-bytes" ? "restored" : "mismatch", launchId, editor: providerEditor?.state.doc.toString(), external });
            }
            const file = window.app.vault.getFileByPath("Welcome.md");
            if (!file) return "not-ready";
            const native = await window.Capacitor.Plugins.GeodeManagedVault.debugProbe({ mode: "verify" });
            await window.app.openFile(file, false);
            const editor = window.app.workspace.activeLeaf?.view?.editor;
            const persisted = await window.hostServices.vaultFiles.read("Welcome.md");
            const external = await window.Capacitor.Plugins.GeodeManagedVault.debugExternalVaultProbe({ mode: "verify" });
            return JSON.stringify({ status: persisted === `\(marker)` && editor?.state.doc.toString() === `\(marker)` && native.status === "restored" && external.status === "restored" ? "restored" : "mismatch", persisted, native, external });
            } catch (error) {
                return JSON.stringify({ status: "error", code: error?.code, message: error?.message, stack: error?.stack });
            }
            """ : """
            try {
            if (!window.app || !window.hostServices || !window.Capacitor?.Plugins?.GeodeManagedVault) return "not-ready";
            const file = window.app.vault.getFileByPath("Welcome.md");
            if (!file) return "not-ready";
            let native;
            try { native = await window.Capacitor.Plugins.GeodeManagedVault.debugProbe({ mode: "edit" }); }
            catch (error) { return JSON.stringify({ status: "error", phase: "managed-probe", code: error?.code, message: error?.message }); }
            await window.app.openFile(file, false);
            const editor = window.app.workspace.activeLeaf?.view?.editor;
            if (!editor) return "missing-editor";
            editor.focus();
            editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: `\(marker)` } });
            let persisted;
            for (let persistenceAttempt = 0; persistenceAttempt < 50; persistenceAttempt += 1) {
                persisted = await window.hostServices.vaultFiles.read("Welcome.md");
                if (persisted === `\(marker)`) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            let external;
            try { external = await window.Capacitor.Plugins.GeodeManagedVault.debugExternalVaultProbe({ mode: "edit" }); }
            catch (error) { return JSON.stringify({ status: "error", phase: "external-probe", code: error?.code, message: error?.message }); }
            return JSON.stringify({ status: persisted === `\(marker)` && native.status === "edited" && external.status === "edited" ? "edited" : "mismatch", persisted, editor: editor.state.doc.toString(), native, external });
            } catch (error) {
                return JSON.stringify({ status: "error", code: error?.code, message: error?.message, stack: error?.stack });
            }
            """

        webView?.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            switch result {
            case .success(let value):
                if (value as? String) == "not-ready", attempt < 50 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        self?.runNativeSmoke(verifyOnly: verifyOnly, attempt: attempt + 1)
                    }
                    return
                }
                NSLog("GEODE_NATIVE_SMOKE_RESULT %@", String(describing: value))
                print("GEODE_NATIVE_SMOKE_RESULT \(value)")
            case .failure(let error):
                NSLog("GEODE_NATIVE_SMOKE_ERROR %@", error.localizedDescription)
                print("GEODE_NATIVE_SMOKE_ERROR \(error.localizedDescription)")
            }
        }
    }
#endif
}

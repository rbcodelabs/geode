import Capacitor
import WebKit

final class GeodeBridgeViewController: CAPBridgeViewController {
    private let managedVaultPlugin = GeodeManagedVaultPlugin()

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(managedVaultPlugin)
    }

    func releaseVaultAccess() {
        managedVaultPlugin.releaseVaultAccess()
    }

#if DEBUG
    private static let editArgument = "--geode-native-smoke-edit"
    private static let verifyArgument = "--geode-native-smoke-verify"

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains(Self.editArgument) || arguments.contains(Self.verifyArgument) else { return }
        runNativeSmoke(verifyOnly: arguments.contains(Self.verifyArgument))
    }

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

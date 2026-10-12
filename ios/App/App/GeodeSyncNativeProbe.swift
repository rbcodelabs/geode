#if DEBUG
import Capacitor
import Security
import UIKit

/// DEBUG simulator-only proof that the renderer's host seams work against the real native plugin: Keychain-backed
/// `host.secrets.app`, and `host.syncSafety` (owner lease, hash-guarded write/trash, private storage) over the real
/// stat/writeBinary/trash/syncPrivate* methods. Launched with `--geode-sync-native-probe` and
/// `GEODE_SYNC_NATIVE_PROBE=1`; the result is published as the accessibility value of a hidden label, the same way the
/// managed-core verifier does, and asserted by AppUITests/SyncNativeProbeUITests.
extension GeodeBridgeViewController {
    static var syncNativeProbeRequested: Bool {
#if targetEnvironment(simulator)
        let process = ProcessInfo.processInfo
        return process.environment["GEODE_SYNC_NATIVE_PROBE"] == "1" && process.arguments.contains("--geode-sync-native-probe")
#else
        return false
#endif
    }

    func runSyncNativeProbeIfRequested() {
        guard Self.syncNativeProbeRequested, view.viewWithTag(0x5A11) == nil else { return }
        let label = UILabel(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        label.tag = 0x5A11
        label.text = "Native sync probe"
        label.font = .systemFont(ofSize: 1)
        label.textColor = .clear
        label.isUserInteractionEnabled = false
        label.isAccessibilityElement = true
        label.accessibilityIdentifier = "native-sync-probe"
        label.accessibilityLabel = "Native sync probe"
        label.accessibilityValue = "{\"pending\":true}"
        view.addSubview(label)
        runSyncNativeProbe(label: label, attempt: 0)
    }

    private func runSyncNativeProbe(label: UILabel, attempt: Int) {
        webView?.callAsyncJavaScript(Self.syncNativeProbeScript, arguments: [:], in: nil, in: .page) { [weak self, weak label] result in
            DispatchQueue.main.async {
                guard let self, let label else { return }
                switch result {
                case .success(let value):
                    if (value as? String) == "not-ready", attempt < 100 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.runSyncNativeProbe(label: label, attempt: attempt + 1) }
                        return
                    }
                    label.accessibilityValue = Self.mergeNativeChecks((value as? String) ?? "{\"ok\":false,\"error\":\"non-string probe result\"}")
                case .failure(let error):
                    label.accessibilityValue = "{\"ok\":false,\"error\":\"\(error.localizedDescription.replacingOccurrences(of: "\"", with: "'"))\"}"
                }
            }
        }
    }

    /// Keychain facts only the app process (which has the entitlement) can assert: device-only protection class that
    /// survives an update, and isolation between service namespaces.
    private static func nativeKeychainChecks() -> [[String: Any]] {
        var checks: [[String: Any]] = []
        func check(_ name: String, _ body: () throws -> Void) {
            do { try body(); checks.append(["name": name, "ok": true]) }
            catch { checks.append(["name": name, "ok": false, "error": String(describing: error)]) }
        }
        struct Failed: Error { let reason: String }
        let service = "com.rbcodelabs.geode.tests.\(UUID().uuidString)"
        let store = GeodeKeychainStore(service: service)
        let other = GeodeKeychainStore(service: service + ".other")
        defer { try? store.remove("a"); try? other.remove("a") }
        let deviceOnly = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        check("keychain item is device-only after first unlock, also after an update") {
            try store.set("a", "one")
            guard try store.accessibility(of: "a") == deviceOnly else { throw Failed(reason: "add") }
            try store.set("a", "two")
            guard try store.accessibility(of: "a") == deviceOnly else { throw Failed(reason: "update") }
        }
        check("keychain service namespaces are isolated") {
            guard try other.get("a") == nil else { throw Failed(reason: "leak") }
            try other.set("a", "other")
            guard try store.get("a") == "two", try other.get("a") == "other" else { throw Failed(reason: "values") }
        }
        return checks
    }

    private static func mergeNativeChecks(_ json: String) -> String {
        guard var object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any], object["ok"] != nil else { return json }
        let native = nativeKeychainChecks()
        object["native"] = native
        if native.contains(where: { $0["ok"] as? Bool != true }) { object["ok"] = false }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return json }
        return String(data: data, encoding: .utf8) ?? json
    }

    private static let syncNativeProbeScript = """
    const hex = (buffer) => [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const sha = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    const buffer = (text) => new TextEncoder().encode(text).buffer;
    const host = window.hostServices;
    if (!host) return "not-ready";
    const out = { ok: false, steps: [] };
    const step = async (name, work) => {
      try { const detail = await work(); out.steps.push({ name, ok: true, detail: detail ?? null }); }
      catch (error) { out.steps.push({ name, ok: false, error: String(error?.message ?? error), code: error?.code ?? null }); throw error; }
    };
    const rejects = async (work, pattern) => {
      try { await work(); } catch (error) { if (pattern.test(String(error?.message ?? error))) return "rejected"; throw error; }
      throw new Error("expected a rejection matching " + pattern);
    };
    try {
      if (!host.syncSafety || !host.secrets?.app) throw new Error("host seams missing");
      // A fresh simulator has no launch vault yet; the probe opens the managed one through the same host the app uses.
      await host.vaultRegistry.openVault("managed://default");
      const key = "probe/" + crypto.randomUUID();
      await step("keychain round trip", async () => {
        const app = host.secrets.app;
        if ((await app.get(key)) !== null) throw new Error("fresh key must be absent");
        await app.set(key, "token-1"); if ((await app.get(key)) !== "token-1") throw new Error("set/get");
        await app.set(key, "token-2 ✓"); if ((await app.get(key)) !== "token-2 ✓") throw new Error("update");
        await app.remove(key); await app.remove(key); if ((await app.get(key)) !== null) throw new Error("remove");
      });
      const safety = host.syncSafety;
      const token = await safety.claimOwner();
      if (!token) throw new Error("no lease");
      const name = "SyncProbe-" + Date.now() + ".md";
      const dir = "SyncProbe Dir-" + Date.now();
      const write = (path, text, expectedHash) => safety.apply(token, { operationId: crypto.randomUUID(), path, expectedHash, kind: "write", data: buffer(text) });
      await step("create then guarded replace", async () => {
        const created = await write(name, "one", null);
        if (created.status !== "applied" || (await host.vaultFiles.read(name)) !== "one") throw new Error("create");
        const replaced = await write(name, "two", await sha("one"));
        if (replaced.status !== "applied" || (await host.vaultFiles.read(name)) !== "two") throw new Error("replace");
      });
      await step("stale hash rejected, file untouched", async () => {
        await rejects(async () => write(name, "three", await sha("not what is there")), /changed before sync application/);
        if ((await host.vaultFiles.read(name)) !== "two") throw new Error("file changed");
      });
      await step("nested create makes parents", async () => {
        await write(dir + "/Deep/inner.md", "nested", null);
        if ((await host.vaultFiles.read(dir + "/Deep/inner.md")) !== "nested") throw new Error("nested");
      });
      await step("non-empty folder cannot be trashed", async () => rejects(() => safety.apply(token, { operationId: crypto.randomUUID(), path: dir + "/Deep", expectedHash: "folder", kind: "trash" }), /live descendants/));
      await step("unsafe path refused", async () => rejects(() => write("../escape.md", "x", null), /Unsafe sync path/));
      await step("trash with matching hash", async () => {
        await safety.apply(token, { operationId: crypto.randomUUID(), path: dir + "/Deep/inner.md", expectedHash: await sha("nested"), kind: "trash" });
        await safety.apply(token, { operationId: crypto.randomUUID(), path: dir + "/Deep", expectedHash: "folder", kind: "trash" });
        await safety.apply(token, { operationId: crypto.randomUUID(), path: dir, expectedHash: "folder", kind: "trash" });
        await safety.apply(token, { operationId: crypto.randomUUID(), path: name, expectedHash: await sha("two"), kind: "trash" });
        if (await host.vaultFiles.exists(name) || await host.vaultFiles.exists(dir)) throw new Error("still present");
      });
      await step("private storage lifecycle, outside the vault", async () => {
        const binding = "b".repeat(64), keyId = crypto.randomUUID();
        await safety.storage(token, binding, { action: "stage", key: keyId, data: buffer("frozen") });
        const back = await safety.storage(token, binding, { action: "read-stage", key: keyId });
        if (new TextDecoder().decode(back) !== "frozen") throw new Error("read-stage");
        await rejects(() => safety.storage(token, binding, { action: "stage", key: keyId, data: buffer("different") }), /differ from retry content/);
        await safety.storage(token, binding, { action: "save-operation", key: keyId, value: { phase: "prepared", payload: { key: keyId } } });
        const ops = await safety.storage(token, binding, { action: "load-operations" });
        if (ops.length !== 1) throw new Error("load-operations");
        const listing = (await host.vaultFiles.list()).map((entry) => entry.path).join("\\n");
        if (/GeodeSyncPrivate|\\.blob|\\.json$/m.test(listing) && listing.includes(keyId)) throw new Error("private bytes visible in the vault");
        await safety.storage(token, binding, { action: "release", key: keyId });
        await safety.storage(token, binding, { action: "sweep", keep: [], force: true });
      });
      await safety.releaseOwner(token);
      out.ok = true;
    } catch (error) { out.error = String(error?.message ?? error); }
    return JSON.stringify(out);
    """
}
#endif

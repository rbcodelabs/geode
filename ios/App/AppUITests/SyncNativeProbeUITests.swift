import XCTest

/// Runs the renderer's mobile `host.syncSafety` and Keychain-backed `host.secrets.app` against the real native plugin
/// inside the app (the XCTest runner process has no Keychain entitlement, the app does). See GeodeSyncNativeProbe.swift.
final class SyncNativeProbeUITests: XCTestCase {
    func testSyncSafetyAndKeychainWorkAgainstTheRealNativePlugin() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments.append("--geode-sync-native-probe")
        app.launchEnvironment["GEODE_SYNC_NATIVE_PROBE"] = "1"
        app.launch()

        let probe = app.staticTexts["Native sync probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 15), "The DEBUG native sync probe label must exist")
        var result: [String: Any]?
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            if let value = probe.value as? String, let data = value.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["pending"] == nil {
                result = object
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        let object = try XCTUnwrap(result, "The probe did not finish; last value: \(String(describing: probe.value))")
        let steps = (object["steps"] as? [[String: Any]] ?? []).map { "\($0["name"] ?? "?"): \($0["ok"] as? Bool == true ? "ok" : "FAILED \($0["error"] ?? "")")" }
        XCTAssertEqual(object["ok"] as? Bool, true, "probe failed: \(object["error"] ?? "unknown"); steps: \(steps)")
        XCTAssertEqual(steps.count, 8, "every step must run: \(steps)")
        let native = (object["native"] as? [[String: Any]] ?? []).map { "\($0["name"] ?? "?"): \($0["ok"] as? Bool == true ? "ok" : "FAILED \($0["error"] ?? "")")" }
        XCTAssertEqual(native.count, 2, "native keychain checks must run: \(native)")
        XCTAssertTrue(native.allSatisfy { $0.contains(": ok") }, "\(native)")
        print("SYNC_NATIVE_PROBE_STEPS \(steps) NATIVE \(native)")
    }
}

import XCTest

/// The XCTest runner process has no Keychain entitlement (SecItem* fails with errSecMissingEntitlement, -34018), so the
/// behaviors that touch the real Keychain are asserted inside the app by SyncNativeProbeUITests (round trip through the
/// renderer's `host.secrets.app`, plus the native protection-class and namespace checks in GeodeSyncNativeProbe.swift).
/// What needs no Keychain lives here.
final class KeychainStoreTests: XCTestCase {
    func testDefaultServiceIsGeodeAppNamespace() {
        XCTAssertEqual(GeodeKeychainStore().service, "com.rbcodelabs.geode.app-secrets")
    }

    func testInvalidKeysAreRefusedBeforeTouchingTheKeychain() {
        let store = GeodeKeychainStore(service: "com.rbcodelabs.geode.tests.\(UUID().uuidString)")
        for key in ["", "has\0nul", String(repeating: "k", count: 257)] {
            XCTAssertThrowsError(try store.get(key)) { XCTAssertEqual($0 as? GeodeKeychainStore.KeychainError, .invalidKey) }
            XCTAssertThrowsError(try store.set(key, "v")) { XCTAssertEqual($0 as? GeodeKeychainStore.KeychainError, .invalidKey) }
            XCTAssertThrowsError(try store.remove(key)) { XCTAssertEqual($0 as? GeodeKeychainStore.KeychainError, .invalidKey) }
        }
    }
}

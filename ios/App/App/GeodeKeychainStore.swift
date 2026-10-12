import Foundation
import Security

/// Geode's own secrets (today: the HTTPS hub token) in the iOS Keychain.
///
/// Items are generic passwords under one service namespace, readable only after the first unlock and never
/// migrated to another device or backup (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). They are not
/// synchronizable. The web layer, device state and the vault never hold the value.
struct GeodeKeychainStore {
    enum KeychainError: Error, Equatable {
        case invalidKey
        case invalidData
        case status(OSStatus)
    }

    /// Distinct from any plugin or vault namespace.
    static let defaultService = "com.rbcodelabs.geode.app-secrets"

    let service: String

    init(service: String = GeodeKeychainStore.defaultService) {
        self.service = service
    }

    private func query(_ key: String) throws -> [String: Any] {
        guard !key.isEmpty, key.utf8.count <= 256, !key.contains("\0") else { throw KeychainError.invalidKey }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false
        ]
    }

    func get(_ key: String) throws -> String? {
        var search = try query(key)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else { throw KeychainError.invalidData }
        return value
    }

    func set(_ key: String, _ value: String) throws {
        guard let data = value.data(using: .utf8) else { throw KeychainError.invalidData }
        let base = try query(key)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            ]
            let updated = SecItemUpdate(base as CFDictionary, update as CFDictionary)
            guard updated == errSecSuccess else { throw KeychainError.status(updated) }
        } else if status != errSecSuccess {
            throw KeychainError.status(status)
        }
    }

    /// Idempotent: removing an absent key succeeds.
    func remove(_ key: String) throws {
        let status = SecItemDelete(try query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }

    /// Reads the protection class back, so a test can prove the item is device-only.
    func accessibility(of key: String) throws -> String? {
        var search = try query(key)
        search[kSecReturnAttributes as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        return (item as? [String: Any])?[kSecAttrAccessible as String] as? String
    }
}

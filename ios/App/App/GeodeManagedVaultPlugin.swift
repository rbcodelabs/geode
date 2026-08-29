import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

private struct ManagedVaultFailure: Error {
    let code: String
    let message: String
    let state: String?
    let vaultId: String?
    let vaultName: String?

    init(code: String, message: String, state: String? = nil, vaultId: String? = nil, vaultName: String? = nil) {
        self.code = code
        self.message = message
        self.state = state
        self.vaultId = vaultId
        self.vaultName = vaultName
    }

    static let invalidPath = ManagedVaultFailure(code: "INVALID_PATH", message: "Expected a safe managed-vault relative path")
    static let notFound = ManagedVaultFailure(code: "NOT_FOUND", message: "Managed-vault item was not found")
    static let collision = ManagedVaultFailure(code: "COLLISION", message: "Managed-vault destination already exists")
    static let unavailable = ManagedVaultFailure(code: "STORAGE_UNAVAILABLE", message: "Managed-vault storage is unavailable")
    static let io = ManagedVaultFailure(code: "IO_FAILURE", message: "Managed-vault I/O failed")
    static let payloadTooLarge = ManagedVaultFailure(code: "PAYLOAD_TOO_LARGE", message: "Binary payload exceeds the 32 MiB bridge limit")
    static let contentUnavailable = ManagedVaultFailure(code: "CONTENT_UNAVAILABLE", message: "Provider content is not currently available")

    static func vault(_ code: String, _ message: String, state: String, id: String, name: String) -> ManagedVaultFailure {
        ManagedVaultFailure(code: code, message: message, state: state, vaultId: id, vaultName: name)
    }
}

private struct ExternalVaultRecord: Codable {
    let id: String
    let registryIdentity: String
    var name: String
    var provider: String
    var bookmark: Data
    let marker: String
    let providerIdentity: Data
    let rootResourceIdentity: Data
    let requiresSecurityScope: Bool
}

private struct ExternalVaultRegistry: Codable {
    var records: [ExternalVaultRecord] = []
    var launchVaultId: String = "managed://default"
}

private struct ManagedVaultEntry {
    let path: String
    let isFolder: Bool
    let mtime: Double
    let ctime: Double
    let size: Int

    var jsObject: JSObject {
        ["path": path, "isFolder": isFolder, "mtime": mtime, "ctime": ctime, "size": size]
    }
}

@objc(GeodeManagedVaultPlugin)
final class GeodeManagedVaultPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "GeodeManagedVaultPlugin"
    public let jsName = "GeodeManagedVault"
    public let pluginMethods: [CAPPluginMethod] = {
        var methods: [CAPPluginMethod?] = [
            CAPPluginMethod(name: "chooseExternalVault", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "reconnectVault", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "describeVault", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "checkVault", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "openVault", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "getRecentVaults", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "getLaunchVault", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "closeVault", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "readBinary", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "trash", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "settleMutation", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "listPluginIds", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "listThemes", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "readPluginFile", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "replacePluginFiles", returnType: CAPPluginReturnPromise)
        ]
#if DEBUG
        methods.append(CAPPluginMethod(name: "debugProbe", returnType: CAPPluginReturnPromise))
        methods.append(CAPPluginMethod(name: "debugExternalVaultProbe", returnType: CAPPluginReturnPromise))
#endif
        return methods.compactMap { $0 }
    }()

    private let fileManager = FileManager.default
    private let ioQueue = DispatchQueue(label: "com.rbcodelabs.geode.managed-vault")
    private let trashName = ".geode-trash"
    private let binaryBridgeLimit = 32 * 1024 * 1024
    private let pluginBridgeLimit = 16 * 1024 * 1024
    private var activeRoot: URL?
    private var activeVaultId: String?
    private var activeAccessURL: URL?
    private var activeAccessNeedsSecurityStop = false
    private var pendingPickerCall: CAPPluginCall?
    private var pendingReconnectId: String?
#if DEBUG
    private var debugAccessStarts = 0
    private var debugAccessStops = 0
#endif

    private var managedVaultRoot: URL {
        get throws {
            guard let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
                throw ManagedVaultFailure.unavailable
            }
            return documents.appendingPathComponent("Geode Vault", isDirectory: true)
        }
    }

    private var vaultRoot: URL {
        get throws {
            guard let activeRoot else { throw ManagedVaultFailure.unavailable }
            return activeRoot
        }
    }

    private var trashRoot: URL {
        get throws { try vaultRoot.appendingPathComponent(trashName, isDirectory: true) }
    }

    @objc func chooseExternalVault(_ call: CAPPluginCall) {
        presentFolderPicker(call, reconnectId: nil)
    }

    @objc func reconnectVault(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), id.hasPrefix("external://") else {
            call.reject("Expected an external vault identity", "VAULT_MISSING")
            return
        }
        presentFolderPicker(call, reconnectId: id)
    }

    private func presentFolderPicker(_ call: CAPPluginCall, reconnectId: String?) {
        DispatchQueue.main.async {
            guard self.pendingPickerCall == nil else {
                call.reject("A folder picker is already open", "PICKER_BUSY")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("Folder picker is unavailable", "VAULT_UNAVAILABLE")
                return
            }
            self.pendingPickerCall = call
            self.pendingReconnectId = reconnectId
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            presenter.present(picker, animated: true)
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let call = pendingPickerCall
        let reconnecting = pendingReconnectId != nil
        pendingPickerCall = nil
        pendingReconnectId = nil
        call?.resolve(reconnecting ? ["reconnected": false] : ["id": NSNull()])
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let call = pendingPickerCall
        let reconnectId = pendingReconnectId
        pendingPickerCall = nil
        pendingReconnectId = nil
        guard let call, let url = urls.first else {
            call?.resolve(reconnectId == nil ? ["id": NSNull()] : ["reconnected": false])
            return
        }
        ioQueue.async {
            do {
                if let reconnectId {
                    try self.reauthorizeExternalVault(reconnectId, url: url)
                    call.resolve(["reconnected": true])
                } else {
                    call.resolve(["id": try self.registerExternalVault(url)])
                }
            }
            catch let failure as ManagedVaultFailure { self.reject(call, failure) }
            catch { self.reject(call, self.map(error)) }
        }
    }

    @objc func describeVault(_ call: CAPPluginCall) {
        perform(call) {
            guard let id = call.getString("id") else { throw ManagedVaultFailure.invalidPath }
            if id == "managed://default" { return ["id": id, "name": "Geode Mobile", "kind": "managed"] }
            let record = try self.record(id)
            return ["id": id, "name": record.name, "kind": "external"]
        }
    }

    @objc func openVault(_ call: CAPPluginCall) {
        perform(call) {
            let id = call.getString("id") ?? "managed://default"
            if id == "managed://default" {
                let root = try self.managedVaultRoot
                try self.prepareVault(at: root, createWelcome: true)
                try self.updateLaunchVault(id)
                self.activate(root: root, id: id, accessURL: nil)
                return ["id": id, "name": "Geode Mobile", "kind": "managed", "status": "ready"]
            }
            let record = try self.record(id)
            return try self.openExternalVault(record)
        }
    }

    @objc func checkVault(_ call: CAPPluginCall) {
        perform(call) {
            let id = call.getString("id") ?? "managed://default"
            if id == "managed://default" {
                try self.prepareVault(at: self.managedVaultRoot, createWelcome: true)
            } else {
                try self.checkExternalVault(try self.record(id))
            }
            return [:]
        }
    }

    @objc func getRecentVaults(_ call: CAPPluginCall) {
        perform(call) { ["ids": ["managed://default"] + (try self.loadRegistry()).records.map(\.id)] }
    }

    @objc func getLaunchVault(_ call: CAPPluginCall) {
        perform(call) { ["id": try self.loadRegistry().launchVaultId] }
    }

    @objc func closeVault(_ call: CAPPluginCall) {
        ioQueue.async {
            self.releaseActiveAccess()
            call.resolve([:])
        }
    }

    func releaseVaultAccess() {
        ioQueue.async { self.releaseActiveAccess() }
    }

    @objc func list(_ call: CAPPluginCall) {
        perform(call) {
            try self.prepareVault()
            return ["entries": try self.recursiveEntries().map(\.jsObject)]
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        perform(call) {
            let url = try self.validatedURL(self.requiredPath(call))
            guard self.fileManager.fileExists(atPath: url.path) else { throw ManagedVaultFailure.notFound }
            let data = try self.readData(url)
            guard let text = String(data: data, encoding: .utf8) else { throw ManagedVaultFailure.io }
            return ["data": text]
        }
    }

    @objc func readBinary(_ call: CAPPluginCall) {
        perform(call) {
            let url = try self.validatedURL(self.requiredPath(call))
            guard self.fileManager.fileExists(atPath: url.path) else { throw ManagedVaultFailure.notFound }
            return ["base64": try self.readBinaryData(url).base64EncodedString()]
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        perform(call) {
            let path = try self.requiredPath(call)
            guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
                throw ManagedVaultFailure.io
            }
            let url = try self.validatedURL(path)
            let existed = self.fileManager.fileExists(atPath: url.path)
            try self.atomicWrite(data, to: url)
            let entry = try self.entry(url, path: path)
            self.emit(event: existed ? "modify" : "create", path: path, mutationId: call.getString("mutationId"))
            return ["mtime": entry.mtime, "ctime": entry.ctime, "size": entry.size]
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        perform(call) {
            let path = try self.requiredPath(call)
            let url = try self.validatedURL(path)
            try self.coordinatedCreateDirectory(url)
            self.emit(event: "create-folder", path: path, mutationId: call.getString("mutationId"))
            return [:]
        }
    }

    @objc func trash(_ call: CAPPluginCall) {
        perform(call) {
            let path = try self.requiredPath(call)
            let source = try self.validatedURL(path)
            guard self.fileManager.fileExists(atPath: source.path) else { throw ManagedVaultFailure.notFound }
            let entries = try self.entriesForMutation(rootURL: source, rootPath: path)
            _ = try self.moveToTrash(source: source, originalPath: path)
            self.emitDeletion(entries, mutationId: call.getString("mutationId"))
            return [:]
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        perform(call) {
            let oldPath = try self.requiredPath(call)
            guard let newPath = call.getString("newPath") else { throw ManagedVaultFailure.invalidPath }
            let source = try self.validatedURL(oldPath)
            let destination = try self.validatedURL(newPath)
            guard self.fileManager.fileExists(atPath: source.path) else { throw ManagedVaultFailure.notFound }
            guard !self.fileManager.fileExists(atPath: destination.path) else { throw ManagedVaultFailure.collision }
            guard !newPath.hasPrefix(oldPath + "/") else { throw ManagedVaultFailure.invalidPath }
            let entries = try self.entriesForMutation(rootURL: source, rootPath: oldPath)
            try self.preflightDestinations(entries: entries, oldRoot: oldPath, newRoot: newPath)
            try self.coordinatedMove(from: source, to: destination)
            let mutationId = call.getString("mutationId")
            self.emitDeletion(entries, mutationId: mutationId)
            for item in entries.sorted(by: { $0.path.count < $1.path.count }) {
                let renamed = newPath + item.path.dropFirst(oldPath.count)
                self.emit(event: item.isFolder ? "create-folder" : "create", path: String(renamed), mutationId: mutationId)
            }
            return [:]
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        perform(call) {
            let url = try self.validatedURL(self.requiredPath(call))
            return ["exists": try self.coordinatedExists(url)]
        }
    }

    /// The serial I/O queue orders this behind the named mutation. Dispatching
    /// the resolution to main orders it behind every listener notification that
    /// mutation enqueued, so the renderer can safely retire its correlation id.
    @objc func settleMutation(_ call: CAPPluginCall) {
        ioQueue.async {
            DispatchQueue.main.async { call.resolve([:]) }
        }
    }

    @objc func listPluginIds(_ call: CAPPluginCall) {
        perform(call) { ["ids": try self.installedDirectoryIds(kind: "plugins", requiresManifest: true)] }
    }

    @objc func listThemes(_ call: CAPPluginCall) {
        perform(call) { ["ids": try self.installedDirectoryIds(kind: "themes", requiresManifest: false)] }
    }

    @objc func readPluginFile(_ call: CAPPluginCall) {
        perform(call) {
            let path = try self.requiredPluginPath(call)
            let url = try self.validatedURL(path)
            let requestedLimit = call.getInt("maxBytes") ?? self.pluginBridgeLimit
            let limit = min(max(requestedLimit, 1), self.pluginBridgeLimit)
            let values = try url.resourceValues(forKeys: [.fileSizeKey])
            guard (values.fileSize ?? 0) <= limit else {
                throw ManagedVaultFailure(code: "PLUGIN_PAYLOAD_TOO_LARGE", message: "Plugin file exceeds the mobile bridge limit")
            }
            let data = try self.readData(url)
            guard data.count <= limit, let content = String(data: data, encoding: .utf8) else {
                throw ManagedVaultFailure(code: "PLUGIN_INVALID_TEXT", message: "Plugin file is not bounded UTF-8 text")
            }
            return ["content": content]
        }
    }

    @objc func replacePluginFiles(_ call: CAPPluginCall) {
        perform(call) {
            guard let id = call.getString("id"), self.isSafePluginId(id),
                  let expectedManifest = call.getString("expectedManifest"),
                  let replacement = call.getObject("replacement"),
                  let manifest = replacement["manifest"] as? String,
                  let main = replacement["main"] as? String else {
                throw ManagedVaultFailure.invalidPath
            }
            let styles = replacement["styles"] as? String
            for value in [manifest, main] + (styles.map { [$0] } ?? []) {
                guard value.lengthOfBytes(using: .utf8) <= self.pluginBridgeLimit else {
                    throw ManagedVaultFailure(code: "PLUGIN_PAYLOAD_TOO_LARGE", message: "Plugin file exceeds the mobile bridge limit")
                }
            }
            try self.atomicReplacePluginFiles(
                id: id,
                expectedManifest: expectedManifest,
                manifest: manifest,
                main: main,
                styles: styles
            )
            return [:]
        }
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping () throws -> JSObject) {
        ioQueue.async {
            do {
                call.resolve(try operation())
            } catch let failure as ManagedVaultFailure {
                self.reject(call, failure)
            } catch {
                let failure = self.map(error)
                self.reject(call, failure)
            }
        }
    }

    private func reject(_ call: CAPPluginCall, _ failure: ManagedVaultFailure) {
        if let state = failure.state, let id = failure.vaultId, let name = failure.vaultName {
            call.reject(failure.message, failure.code, failure, ["id": id, "name": name, "state": state])
        } else {
            call.reject(failure.message, failure.code, failure)
        }
    }

    private func requiredPath(_ call: CAPPluginCall) throws -> String {
        guard let path = call.getString("path") else { throw ManagedVaultFailure.invalidPath }
        return path
    }

    private func isSafePluginId(_ id: String) -> Bool {
        id.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil
    }

    private func requiredPluginPath(_ call: CAPPluginCall) throws -> String {
        guard let path = call.getString("path"),
              path.range(of: "^\\.geode/plugins/[a-z0-9][a-z0-9-]*/(manifest\\.json|main\\.js|styles\\.css)$", options: .regularExpression) != nil else {
            throw ManagedVaultFailure(code: "INVALID_PLUGIN_PATH", message: "Expected a scoped plugin file")
        }
        return path
    }

    private func installedDirectoryIds(kind: String, requiresManifest: Bool) throws -> [String] {
        try prepareVault()
        guard kind == "plugins" || kind == "themes" else { throw ManagedVaultFailure.invalidPath }
        let directory = try validatedURL(".geode/\(kind)")
        guard fileManager.fileExists(atPath: directory.path) else { return [] }
        var coordinationError: NSError?
        var operationError: Error?
        var ids: [String] = []
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: directory, options: [], error: &coordinationError) { coordinated in
            do {
                ids = try self.fileManager.contentsOfDirectory(at: coordinated, includingPropertiesForKeys: [.isDirectoryKey])
                    .filter { url in
                        guard self.isSafePluginId(url.lastPathComponent),
                              (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return false }
                        return !requiresManifest || self.fileManager.fileExists(atPath: url.appendingPathComponent("manifest.json").path)
                    }
                    .map(\.lastPathComponent)
                    .sorted()
            } catch { operationError = error }
        }
        if let error = coordinationError ?? operationError { throw map(error) }
        return ids
    }

    private func atomicReplacePluginFiles(
        id: String,
        expectedManifest: String,
        manifest: String,
        main: String,
        styles: String?,
        injectBeforeSwapFailure: Bool = false
    ) throws {
        guard isSafePluginId(id) else { throw ManagedVaultFailure.invalidPath }
        let pluginDirectory = try validatedURL(".geode/plugins/\(id)")
        guard fileManager.fileExists(atPath: pluginDirectory.path) else { throw ManagedVaultFailure.notFound }
        let parent = pluginDirectory.deletingLastPathComponent()
        let staging = parent.appendingPathComponent(".geode-plugin-stage-\(UUID().uuidString)", isDirectory: true)
        let backupName = ".geode-plugin-backup-\(UUID().uuidString)"
        let backup = parent.appendingPathComponent(backupName, isDirectory: true)
        var coordinationError: NSError?
        var operationError: Error?
        var committed = false
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: pluginDirectory, options: .forReplacing, error: &coordinationError) { coordinated in
            do {
                let currentManifestURL = coordinated.appendingPathComponent("manifest.json")
                let currentManifest = String(data: try Data(contentsOf: currentManifestURL), encoding: .utf8)
                guard currentManifest == expectedManifest else {
                    throw ManagedVaultFailure(code: "PLUGIN_FILES_CHANGED", message: "Plugin manifest changed before replacement")
                }
                try self.fileManager.copyItem(at: coordinated, to: staging)
                try Data(manifest.utf8).write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)
                try Data(main.utf8).write(to: staging.appendingPathComponent("main.js"), options: .atomic)
                let styleURL = staging.appendingPathComponent("styles.css")
                if let styles { try Data(styles.utf8).write(to: styleURL, options: .atomic) }
                else if self.fileManager.fileExists(atPath: styleURL.path) { try self.fileManager.removeItem(at: styleURL) }
                if injectBeforeSwapFailure { throw ManagedVaultFailure.io }
                _ = try self.fileManager.replaceItemAt(coordinated, withItemAt: staging, backupItemName: backupName)
                committed = true
            } catch { operationError = error }
        }
        defer {
            try? fileManager.removeItem(at: staging)
            try? fileManager.removeItem(at: backup)
        }
        if let error = coordinationError ?? operationError {
            if committed, fileManager.fileExists(atPath: backup.path) {
                try? fileManager.removeItem(at: pluginDirectory)
                try? fileManager.moveItem(at: backup, to: pluginDirectory)
            }
            throw map(error)
        }
    }

    private var registryURL: URL {
        get throws {
            guard let applicationSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                throw ManagedVaultFailure.unavailable
            }
            let directory = applicationSupport.appendingPathComponent("Geode", isDirectory: true)
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            return directory.appendingPathComponent("external-vault-registry.json")
        }
    }

    private func loadRegistry() throws -> ExternalVaultRegistry {
        let url = try registryURL
        guard fileManager.fileExists(atPath: url.path) else { return ExternalVaultRegistry() }
        do { return try JSONDecoder().decode(ExternalVaultRegistry.self, from: Data(contentsOf: url)) }
        catch { throw ManagedVaultFailure.unavailable }
    }

    private func saveRegistry(_ registry: ExternalVaultRegistry) throws {
        let url = try registryURL
        let data = try JSONEncoder().encode(registry)
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
        } catch { throw ManagedVaultFailure.unavailable }
    }

    private func record(_ id: String) throws -> ExternalVaultRecord {
        guard id.hasPrefix("external://"), let record = try loadRegistry().records.first(where: { $0.id == id }) else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault registry entry is missing", state: "missing", id: id, name: "Unavailable vault")
        }
        return record
    }

    private func replaceRecord(_ record: ExternalVaultRecord) throws {
        var registry = try loadRegistry()
        guard let index = registry.records.firstIndex(where: { $0.id == record.id }) else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault registry entry is missing", state: "missing", id: record.id, name: record.name)
        }
        registry.records[index] = record
        try saveRegistry(registry)
    }

    private func updateLaunchVault(_ id: String) throws {
        var registry = try loadRegistry()
        registry.launchVaultId = id
        try saveRegistry(registry)
    }

    private func registerExternalVault(_ url: URL, requiresSecurityScope: Bool = true) throws -> String {
        guard beginAccess(url, requiresSecurityScope: requiresSecurityScope) else {
            throw ManagedVaultFailure.vault("VAULT_PERMISSION_REVOKED", "Folder permission was not granted", state: "permission-revoked", id: "external://pending", name: url.lastPathComponent)
        }
        defer {
            endAccess(url, requiresSecurityScope: requiresSecurityScope)
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Selected folder is missing", state: "missing", id: "external://pending", name: url.lastPathComponent)
        }
        let marker = try ensureVaultMarker(url)
        let identity = try rootIdentity(url)
        let bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        let provider = (try? url.resourceValues(forKeys: [.volumeLocalizedNameKey]).volumeLocalizedName) ?? "Files"
        var registry = try loadRegistry()
        if let index = registry.records.firstIndex(where: {
            $0.providerIdentity == identity.providerIdentity &&
            $0.rootResourceIdentity == identity.rootResourceIdentity
        }) {
            registry.records[index].bookmark = bookmark
            registry.records[index].name = url.lastPathComponent
            registry.records[index].provider = provider
            try saveRegistry(registry)
            return registry.records[index].id
        }
        let registryIdentity = UUID().uuidString.lowercased()
        let id = "external://\(registryIdentity)"
        registry.records.append(ExternalVaultRecord(
            id: id, registryIdentity: registryIdentity, name: url.lastPathComponent,
            provider: provider, bookmark: bookmark, marker: marker,
            providerIdentity: identity.providerIdentity,
            rootResourceIdentity: identity.rootResourceIdentity,
            requiresSecurityScope: requiresSecurityScope
        ))
        try saveRegistry(registry)
        return id
    }

    private func reauthorizeExternalVault(_ id: String, url: URL, requiresSecurityScope: Bool = true) throws {
        var existing = try record(id)
        guard beginAccess(url, requiresSecurityScope: requiresSecurityScope) else {
            throw ManagedVaultFailure.vault("VAULT_PERMISSION_REVOKED", "Folder permission was not granted", state: "permission-revoked", id: id, name: existing.name)
        }
        defer {
            endAccess(url, requiresSecurityScope: requiresSecurityScope)
        }
        let identity = try rootIdentity(url)
        guard (try? readVaultMarker(url)) == existing.marker,
              identity.providerIdentity == existing.providerIdentity,
              identity.rootResourceIdentity == existing.rootResourceIdentity else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "That folder is not the same vault", state: "missing", id: id, name: existing.name)
        }
        existing.bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        existing.name = url.lastPathComponent
        existing.provider = (try? url.resourceValues(forKeys: [.volumeLocalizedNameKey]).volumeLocalizedName) ?? "Files"
        try replaceRecord(existing)
    }

    private func openExternalVault(
        _ record: ExternalVaultRecord,
        forceStale: Bool = false,
        forcePermissionDenied: Bool = false
    ) throws -> JSObject {
        var isStale = false
        let resolved: URL
        do {
            resolved = try URL(
                resolvingBookmarkData: record.bookmark,
                options: [.withoutUI],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
        } catch {
            let cocoa = error as NSError
            if cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSFileNoSuchFileError {
                throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault folder is missing", state: "missing", id: record.id, name: record.name)
            }
            throw ManagedVaultFailure.vault("VAULT_UNAVAILABLE", "Vault bookmark is unavailable", state: "unavailable", id: record.id, name: record.name)
        }
        guard !forcePermissionDenied,
              beginAccess(resolved, requiresSecurityScope: record.requiresSecurityScope) else {
            throw ManagedVaultFailure.vault("VAULT_PERMISSION_REVOKED", "Vault permission was revoked", state: "permission-revoked", id: record.id, name: record.name)
        }
        var keepAccess = false
        defer {
            if !keepAccess { endAccess(resolved, requiresSecurityScope: record.requiresSecurityScope) }
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: resolved.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault folder is missing", state: "missing", id: record.id, name: record.name)
        }
        guard (try? readVaultMarker(resolved)) == record.marker else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Selected folder no longer matches this vault", state: "missing", id: record.id, name: record.name)
        }
        let identity = try rootIdentity(resolved)
        guard identity.providerIdentity == record.providerIdentity,
              identity.rootResourceIdentity == record.rootResourceIdentity else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault identity no longer matches this folder", state: "missing", id: record.id, name: record.name)
        }
        let stale = isStale || forceStale
        if stale {
            var refreshed = record
            refreshed.bookmark = try resolved.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
            try replaceRecord(refreshed)
        }
        try prepareVault(at: resolved, createWelcome: false)
        try updateLaunchVault(record.id)
        activate(root: resolved, id: record.id, accessURL: resolved, requiresSecurityStop: record.requiresSecurityScope)
        keepAccess = true
        return ["id": record.id, "name": record.name, "kind": "external", "status": stale ? "stale-refreshed" : "ready"]
    }

    /// Resolve and validate an exact external vault without changing activeRoot,
    /// active security-scoped access, or the launch-vault commitment.
    private func checkExternalVault(_ record: ExternalVaultRecord) throws {
        var isStale = false
        let resolved: URL
        do {
            resolved = try URL(
                resolvingBookmarkData: record.bookmark,
                options: [.withoutUI],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
        } catch {
            let cocoa = error as NSError
            if cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSFileNoSuchFileError {
                throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault folder is missing", state: "missing", id: record.id, name: record.name)
            }
            throw ManagedVaultFailure.vault("VAULT_UNAVAILABLE", "Vault bookmark is unavailable", state: "unavailable", id: record.id, name: record.name)
        }
        guard beginAccess(resolved, requiresSecurityScope: record.requiresSecurityScope) else {
            throw ManagedVaultFailure.vault("VAULT_PERMISSION_REVOKED", "Vault permission was revoked", state: "permission-revoked", id: record.id, name: record.name)
        }
        defer { endAccess(resolved, requiresSecurityScope: record.requiresSecurityScope) }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: resolved.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault folder is missing", state: "missing", id: record.id, name: record.name)
        }
        guard (try? readVaultMarker(resolved)) == record.marker else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Selected folder no longer matches this vault", state: "missing", id: record.id, name: record.name)
        }
        let identity = try rootIdentity(resolved)
        guard identity.providerIdentity == record.providerIdentity,
              identity.rootResourceIdentity == record.rootResourceIdentity else {
            throw ManagedVaultFailure.vault("VAULT_MISSING", "Vault identity no longer matches this folder", state: "missing", id: record.id, name: record.name)
        }
    }

    private func ensureVaultMarker(_ root: URL) throws -> String {
        let directory = root.appendingPathComponent(".geode", isDirectory: true)
        let markerURL = directory.appendingPathComponent("vault-id", isDirectory: false)
        if fileManager.fileExists(atPath: markerURL.path) {
            let marker = String(data: try coordinatedReadData(markerURL), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard UUID(uuidString: marker) != nil else { throw ManagedVaultFailure.io }
            return marker.lowercased()
        }
        var coordinationError: NSError?
        var operationError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: directory, options: .forMerging, error: &coordinationError) { coordinated in
            do { try self.fileManager.createDirectory(at: coordinated, withIntermediateDirectories: true) }
            catch { operationError = error }
        }
        if let error = coordinationError ?? operationError { throw map(error) }
        let marker = UUID().uuidString.lowercased()
        try atomicWrite(Data(marker.utf8), to: markerURL)
        return marker
    }

    private func readVaultMarker(_ root: URL) throws -> String {
        let marker = root.appendingPathComponent(".geode/vault-id", isDirectory: false)
        guard fileManager.fileExists(atPath: marker.path) else { throw ManagedVaultFailure.notFound }
        return String(data: try coordinatedReadData(marker), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private func rootIdentity(_ root: URL) throws -> (providerIdentity: Data, rootResourceIdentity: Data) {
        let values = try root.resourceValues(forKeys: [.volumeIdentifierKey, .fileResourceIdentifierKey])
        guard let providerIdentity = stableIdentityData(values.volumeIdentifier),
              let rootResourceIdentity = stableIdentityData(values.fileResourceIdentifier) else {
            throw ManagedVaultFailure.vault(
                "VAULT_UNAVAILABLE", "This provider cannot prove a stable folder identity",
                state: "unavailable", id: "external://pending", name: root.lastPathComponent
            )
        }
        return (providerIdentity, rootResourceIdentity)
    }

    private func stableIdentityData(_ value: Any?) -> Data? {
        if let value = value as? Data { return value }
        if let value = value as? UUID { return Data(value.uuidString.lowercased().utf8) }
        if let value = value as? String { return Data(value.utf8) }
        if let value = value as? NSNumber { return Data(value.stringValue.utf8) }
        guard let value = value as? NSObject else { return nil }
        return try? NSKeyedArchiver.archivedData(withRootObject: value, requiringSecureCoding: false)
    }

    private func beginAccess(_ url: URL, requiresSecurityScope: Bool) -> Bool {
        let started = !requiresSecurityScope || url.startAccessingSecurityScopedResource()
#if DEBUG
        if started { debugAccessStarts += 1 }
#endif
        return started
    }

    private func endAccess(_ url: URL, requiresSecurityScope: Bool) {
        if requiresSecurityScope { url.stopAccessingSecurityScopedResource() }
#if DEBUG
        debugAccessStops += 1
#endif
    }

    private func activate(root: URL, id: String, accessURL: URL?, requiresSecurityStop: Bool = false) {
        releaseActiveAccess()
        activeRoot = root
        activeVaultId = id
        activeAccessURL = accessURL
        activeAccessNeedsSecurityStop = requiresSecurityStop
    }

    private func releaseActiveAccess() {
        if let access = activeAccessURL {
            endAccess(access, requiresSecurityScope: activeAccessNeedsSecurityStop)
        }
        activeAccessURL = nil
        activeAccessNeedsSecurityStop = false
        activeRoot = nil
        activeVaultId = nil
    }

    private func prepareVault() throws {
        let root = try vaultRoot
        try prepareVault(at: root, createWelcome: activeVaultId == "managed://default")
    }

    private func prepareVault(at root: URL, createWelcome: Bool) throws {
        do {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: root.appendingPathComponent(trashName, isDirectory: true), withIntermediateDirectories: true)
            let welcome = root.appendingPathComponent("Welcome.md")
            if createWelcome && !fileManager.fileExists(atPath: welcome.path) {
                try atomicWrite(Data("# Welcome to Geode Mobile\n".utf8), to: welcome)
            }
        } catch let failure as ManagedVaultFailure {
            throw failure
        } catch {
            throw map(error)
        }
    }

    private func validatedURL(_ path: String) throws -> URL {
        guard !path.isEmpty,
              !path.contains("\0"),
              !path.hasPrefix("/"),
              !path.contains("\\"),
              path.range(of: "^[A-Za-z]:[\\\\/]", options: .regularExpression) == nil else {
            throw ManagedVaultFailure.invalidPath
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
              components.first != Substring(trashName),
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw ManagedVaultFailure.invalidPath
        }

        let root = try vaultRoot.standardizedFileURL.resolvingSymlinksInPath()
        var candidate = try vaultRoot.standardizedFileURL
        for component in components {
            candidate.appendPathComponent(String(component), isDirectory: false)
            let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
            guard resolved.path.hasPrefix(root.path + "/") else { throw ManagedVaultFailure.invalidPath }
        }
        return candidate.standardizedFileURL
    }

    private func recursiveEntries() throws -> [ManagedVaultEntry] {
        let root = try vaultRoot
        return try coordinatedDirectoryEntries(root)
    }

    private func coordinatedDirectoryEntries(_ root: URL) throws -> [ManagedVaultEntry] {
        var coordinationError: NSError?
        var operationError: Error?
        var result: [ManagedVaultEntry]?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: root, options: [], error: &coordinationError) { coordinated in
            do { result = try self.enumerateEntries(coordinated) }
            catch { operationError = error }
        }
        if let error = coordinationError ?? operationError { throw map(error) }
        guard let result else { throw ManagedVaultFailure.io }
        return result
    }

    private func enumerateEntries(_ root: URL) throws -> [ManagedVaultEntry] {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .creationDateKey, .contentModificationDateKey]
        guard let enumerator = fileManager.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsPackageDescendants]) else {
            throw ManagedVaultFailure.unavailable
        }
        var result: [ManagedVaultEntry] = []
        while let url = enumerator.nextObject() as? URL {
            let relative = String(url.path.dropFirst(root.path.count + 1))
            if relative == trashName || relative.hasPrefix(trashName + "/") {
                enumerator.skipDescendants()
                continue
            }
            let values = try url.resourceValues(forKeys: Set(keys))
            if values.isSymbolicLink == true {
                enumerator.skipDescendants()
                continue
            }
            result.append(try entry(url, path: relative))
        }
        return result.sorted { $0.path < $1.path }
    }

    private func coordinatedCreateDirectory(_ url: URL) throws {
        guard !fileManager.fileExists(atPath: url.path) else { throw ManagedVaultFailure.collision }
        var coordinationError: NSError?
        var operationError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: [], error: &coordinationError) { coordinated in
            do {
                guard !self.fileManager.fileExists(atPath: coordinated.path) else { throw ManagedVaultFailure.collision }
                try self.fileManager.createDirectory(at: coordinated, withIntermediateDirectories: true)
            } catch { operationError = error }
        }
        if let error = coordinationError ?? operationError { throw map(error) }
    }

    private func coordinatedExists(_ url: URL) throws -> Bool {
        let root = try vaultRoot
        let relative = String(url.path.dropFirst(root.path.count + 1))
        var coordinationError: NSError?
        var result = false
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: root, options: [], error: &coordinationError) { coordinated in
            result = self.fileManager.fileExists(atPath: coordinated.appendingPathComponent(relative).path)
        }
        if let coordinationError { throw map(coordinationError) }
        return result
    }

    private func entriesForMutation(rootURL: URL, rootPath: String) throws -> [ManagedVaultEntry] {
        var entries = [try entry(rootURL, path: rootPath)]
        if entries[0].isFolder {
            let root = try vaultRoot
            for item in try recursiveEntries() where item.path.hasPrefix(rootPath + "/") {
                _ = root
                entries.append(item)
            }
        }
        return entries
    }

    private func entry(_ url: URL, path: String) throws -> ManagedVaultEntry {
        do {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .creationDateKey, .contentModificationDateKey])
            return ManagedVaultEntry(
                path: path,
                isFolder: values.isDirectory == true,
                mtime: (values.contentModificationDate ?? .distantPast).timeIntervalSince1970 * 1000,
                ctime: (values.creationDate ?? .distantPast).timeIntervalSince1970 * 1000,
                size: values.isDirectory == true ? 0 : (values.fileSize ?? 0)
            )
        } catch {
            throw map(error)
        }
    }

    private func coordinatedReadData(_ url: URL) throws -> Data {
        var coordinationError: NSError?
        var operationError: Error?
        var result: Data?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
            do { result = try Data(contentsOf: coordinated, options: [.mappedIfSafe]) }
            catch { operationError = error }
        }
        if let error = coordinationError ?? operationError { throw map(error) }
        guard let result else { throw ManagedVaultFailure.io }
        return result
    }

    private func readData(_ url: URL) throws -> Data {
        if fileManager.isUbiquitousItem(at: url),
           let status = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]).ubiquitousItemDownloadingStatus,
           status != .current {
            throw ManagedVaultFailure.contentUnavailable
        }
        return try coordinatedReadData(url)
    }

    private func readBinaryData(_ url: URL) throws -> Data {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard (values.fileSize ?? 0) <= binaryBridgeLimit else { throw ManagedVaultFailure.payloadTooLarge }
        return try readData(url)
    }

    private func synchronize(_ url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        do {
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
    }

    private func atomicWrite(_ data: Data, to destination: URL, injectPostSwapFailure: Bool = false) throws {
        let parent = destination.deletingLastPathComponent()
        guard fileManager.fileExists(atPath: parent.path) else { throw ManagedVaultFailure.notFound }
        let temporary = parent.appendingPathComponent(".geode-write-\(UUID().uuidString)")
        let backup = parent.appendingPathComponent(".geode-backup-\(UUID().uuidString)")
        let hadOriginal = fileManager.fileExists(atPath: destination.path)
        var swapped = false
        do {
            try data.write(to: temporary, options: [.withoutOverwriting])
            try synchronize(temporary)
            if hadOriginal {
                try fileManager.copyItem(at: destination, to: backup)
                try synchronize(backup)
            }
            var coordinationError: NSError?
            var operationError: Error?
            NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: destination, options: .forReplacing, error: &coordinationError) { coordinated in
                do {
                    if self.fileManager.fileExists(atPath: coordinated.path) {
                        _ = try self.fileManager.replaceItemAt(coordinated, withItemAt: temporary)
                    } else {
                        try self.fileManager.moveItem(at: temporary, to: coordinated)
                    }
                    swapped = true
                    if injectPostSwapFailure { throw ManagedVaultFailure.io }
                    try self.synchronize(coordinated)
                } catch {
                    operationError = error
                }
            }
            if let error = coordinationError ?? operationError { throw error }
            try? fileManager.removeItem(at: backup)
        } catch {
            if swapped {
                try? fileManager.removeItem(at: destination)
                if hadOriginal {
                    do {
                        try fileManager.moveItem(at: backup, to: destination)
                        try synchronize(destination)
                    } catch {
                        try? fileManager.removeItem(at: temporary)
                        throw map(error)
                    }
                }
            }
            try? fileManager.removeItem(at: temporary)
            try? fileManager.removeItem(at: backup)
            throw map(error)
        }
    }

    private func moveToTrash(
        source: URL,
        originalPath: String,
        injectDestinationDelay: Bool = false,
        injectDestinationCollision: Bool = false,
        injectCancellation: Bool = false
    ) throws -> URL {
        let record = try trashRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let payload = record.appendingPathComponent("payload", isDirectory: false)
        do {
            try fileManager.createDirectory(at: record, withIntermediateDirectories: false)
            let metadata = try JSONSerialization.data(withJSONObject: [
                "originalPath": originalPath,
                "trashedAt": Date().timeIntervalSince1970 * 1000
            ], options: [.sortedKeys])
            try atomicWrite(metadata, to: record.appendingPathComponent("metadata.json"))
            try coordinatedMove(
                from: source, to: payload,
                injectDestinationDelay: injectDestinationDelay,
                injectDestinationCollision: injectDestinationCollision,
                injectCancellation: injectCancellation
            )
            return record
        } catch {
            try? fileManager.removeItem(at: record)
            throw map(error)
        }
    }

    private func preflightDestinations(entries: [ManagedVaultEntry], oldRoot: String, newRoot: String) throws {
        for item in entries {
            let destinationPath = newRoot + item.path.dropFirst(oldRoot.count)
            let destination = try validatedURL(String(destinationPath))
            if fileManager.fileExists(atPath: destination.path) { throw ManagedVaultFailure.collision }
        }
    }

    private func coordinatedMove(
        from source: URL,
        to destination: URL,
        injectDestinationDelay: Bool = false,
        injectDestinationCollision: Bool = false,
        injectCancellation: Bool = false
    ) throws {
        var coordinationError: NSError?
        var operationError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(
            writingItemAt: source,
            options: .forMoving,
            writingItemAt: destination,
            options: [],
            error: &coordinationError
        ) { coordinatedSource, coordinatedDestination in
            do {
#if DEBUG
                NSLog("GEODE_COORDINATED_MOVE_PATHS source=%@ destination=%@ exists=%@", coordinatedSource.path, coordinatedDestination.path, self.fileManager.fileExists(atPath: coordinatedDestination.path) ? "yes" : "no")
#endif
                var createdInjectedCollision = false
                defer {
                    if createdInjectedCollision { try? self.fileManager.removeItem(at: coordinatedDestination) }
                }
                if injectDestinationDelay { Thread.sleep(forTimeInterval: 1.05) }
                if injectCancellation { throw ManagedVaultFailure.io }
                if injectDestinationCollision {
                    try Data("injected-collision".utf8).write(to: coordinatedDestination, options: [.withoutOverwriting])
                    createdInjectedCollision = true
                }
                guard self.fileManager.fileExists(atPath: coordinatedDestination.deletingLastPathComponent().path) else {
                    throw ManagedVaultFailure.notFound
                }
                guard !self.fileManager.fileExists(atPath: coordinatedDestination.path) else {
                    throw ManagedVaultFailure.collision
                }
                try self.fileManager.moveItem(at: coordinatedSource, to: coordinatedDestination)
            } catch { operationError = error }
        }
        if let error = coordinationError ?? operationError {
#if DEBUG
            NSLog("GEODE_COORDINATED_MOVE_ERROR %@", String(describing: error))
#endif
            throw map(error)
        }
    }

    private func emitDeletion(_ entries: [ManagedVaultEntry], mutationId: String?) {
        for item in entries.sorted(by: { $0.path.count > $1.path.count }) {
            emit(event: item.isFolder ? "delete-folder" : "delete", path: item.path, mutationId: mutationId)
        }
    }

    private func emit(event: String, path: String, mutationId: String?) {
        var data: JSObject = ["event": event, "path": path]
        if let mutationId { data["mutationId"] = mutationId }
        DispatchQueue.main.async { self.notifyListeners("change", data: data) }
    }

    private func map(_ error: Error) -> ManagedVaultFailure {
        if let failure = error as? ManagedVaultFailure { return failure }
        let cocoa = error as NSError
        if cocoa.domain == NSCocoaErrorDomain {
            if cocoa.code == NSFileNoSuchFileError { return .notFound }
            if cocoa.code == NSFileWriteFileExistsError { return .collision }
        }
        return .io
    }

#if DEBUG
    @objc func debugExternalVaultProbe(_ call: CAPPluginCall) {
        perform(call) {
            let mode = call.getString("mode") ?? "edit"
            let documents = try self.managedVaultRoot.deletingLastPathComponent()
            let originalRoot = documents.appendingPathComponent("External Vault Fixture", isDirectory: true)
            let movedRoot = documents.appendingPathComponent("External Vault Fixture Moved", isDirectory: true)
            let copiedRoot = documents.appendingPathComponent("External Vault Fixture Copy", isDirectory: true)

            if mode == "verify" {
                let record = try self.loadRegistry().records.first(where: { $0.name == "External Vault Fixture" || $0.name == "External Vault Fixture Moved" })
                guard let record else { throw ManagedVaultFailure.notFound }
                let opened = try self.openExternalVault(record)
                let bytes = try self.readData(self.validatedURL("Notes/Proof.md"))
                let coldReopenId = opened["id"] as? String ?? "missing"
                self.releaseActiveAccess()
                return [
                    "status": "restored", "coldReopenId": coldReopenId,
                    "bytes": bytes.base64EncodedString(),
                    "accessBalanced": self.debugAccessStarts == self.debugAccessStops
                ]
            }

            self.releaseActiveAccess()
            try? self.fileManager.removeItem(at: originalRoot)
            try? self.fileManager.removeItem(at: movedRoot)
            try? self.fileManager.removeItem(at: copiedRoot)
            var registry = try self.loadRegistry()
            registry.records.removeAll {
                $0.name == "External Vault Fixture" ||
                $0.name == "External Vault Fixture Moved" ||
                $0.name == "External Vault Fixture Copy"
            }
            registry.launchVaultId = "managed://default"
            try self.saveRegistry(registry)
            try self.fileManager.createDirectory(at: originalRoot, withIntermediateDirectories: false)
            let id = try self.registerExternalVault(originalRoot, requiresSecurityScope: false)
            let fixture = try self.record(id)
            let activeBeforeCheck = self.activeVaultId
            try self.checkExternalVault(fixture)
            let checkDidNotActivate = self.activeVaultId == activeBeforeCheck
            let cancelCountBefore = (try self.loadRegistry()).records.count
            let cancelCountAfter = (try self.loadRegistry()).records.count

            let staleOpen = try self.openExternalVault(fixture, forceStale: true)
            try self.fileManager.createDirectory(at: self.validatedURL("Notes"), withIntermediateDirectories: false)
            try self.atomicWrite(Data("provider-bytes".utf8), to: self.validatedURL("Notes/Proof.md"))
            try self.coordinatedMove(from: self.validatedURL("Notes/Proof.md"), to: self.validatedURL("Notes/Renamed.md"))
            try self.coordinatedMove(from: self.validatedURL("Notes/Renamed.md"), to: self.validatedURL("Notes/Proof.md"))
            let exactBytes = try self.readData(self.validatedURL("Notes/Proof.md")).base64EncodedString()

            self.releaseActiveAccess()
            try self.fileManager.copyItem(at: originalRoot, to: copiedRoot)
            let copiedMarkerNewId = try self.registerExternalVault(copiedRoot, requiresSecurityScope: false)
            var copiedMarkerReconnectCode = "missing"
            do { try self.reauthorizeExternalVault(id, url: copiedRoot, requiresSecurityScope: false) }
            catch let failure as ManagedVaultFailure { copiedMarkerReconnectCode = failure.code }
            registry = try self.loadRegistry()
            registry.records.removeAll { $0.id == copiedMarkerNewId }
            try self.saveRegistry(registry)
            try self.fileManager.removeItem(at: copiedRoot)
            _ = try self.openExternalVault(try self.record(id))

            var siblingEscapeCode = "missing"
            do { _ = try self.validatedURL("../Sibling.md") }
            catch let failure as ManagedVaultFailure { siblingEscapeCode = failure.code }
            let sibling = originalRoot.deletingLastPathComponent().appendingPathComponent("Sibling Secret")
            try self.atomicWrite(Data("secret".utf8), to: sibling)
            let symlink = try self.validatedURL("SiblingLink")
            try self.fileManager.createSymbolicLink(at: symlink, withDestinationURL: sibling)
            var symlinkEscapeCode = "missing"
            do { _ = try self.validatedURL("SiblingLink/Child.md") }
            catch let failure as ManagedVaultFailure { symlinkEscapeCode = failure.code }
            try? self.fileManager.removeItem(at: symlink)
            try? self.fileManager.removeItem(at: sibling)

            try self.atomicWrite(Data("trash-provider".utf8), to: self.validatedURL("Trash.md"))
            let trashRecord = try self.moveToTrash(source: self.validatedURL("Trash.md"), originalPath: "Trash.md")
            let trashBytes = try self.readData(trashRecord.appendingPathComponent("payload")).base64EncodedString()

            self.releaseActiveAccess()
            try self.fileManager.moveItem(at: originalRoot, to: movedRoot)
            var movedRecord = try self.record(id)
            movedRecord.name = "External Vault Fixture Moved"
            let movedOpen = try self.openExternalVault(movedRecord)
            let movedReopenId = movedOpen["id"] as? String ?? "missing"
            let originalMovePreservedId = movedReopenId
            self.releaseActiveAccess()
            let coldOpen = try self.openExternalVault(try self.record(id))
            let coldReopenId = coldOpen["id"] as? String ?? "missing"

            var revokedCode = "missing"
            do { _ = try self.openExternalVault(try self.record(id), forcePermissionDenied: true) }
            catch let failure as ManagedVaultFailure { revokedCode = failure.code }

            let missingRoot = documents.appendingPathComponent("Missing External Fixture", isDirectory: true)
            try? self.fileManager.removeItem(at: missingRoot)
            try self.fileManager.createDirectory(at: missingRoot, withIntermediateDirectories: false)
            let missingMarker = try self.ensureVaultMarker(missingRoot)
            let missingIdentity = try self.rootIdentity(missingRoot)
            let missingRegistryIdentity = UUID().uuidString.lowercased()
            let missingRecord = ExternalVaultRecord(
                id: "external://\(missingRegistryIdentity)", registryIdentity: missingRegistryIdentity,
                name: "Missing External Fixture", provider: "DEBUG",
                bookmark: try missingRoot.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil),
                marker: missingMarker, providerIdentity: missingIdentity.providerIdentity,
                rootResourceIdentity: missingIdentity.rootResourceIdentity, requiresSecurityScope: false
            )
            try self.fileManager.removeItem(at: missingRoot)
            var missingCode = "missing"
            do { _ = try self.openExternalVault(missingRecord) }
            catch let failure as ManagedVaultFailure { missingCode = failure.code }

            self.releaseActiveAccess()
            let accessBalanced = self.debugAccessStarts == self.debugAccessStops
            return [
                "status": "edited", "id": id, "staleStatus": staleOpen["status"] as? String ?? "missing",
                "cancelUnchanged": cancelCountBefore == cancelCountAfter,
                "exactBytes": exactBytes, "trashBytes": trashBytes,
                "movedReopenId": movedReopenId, "coldReopenId": coldReopenId,
                "copiedMarkerNewId": copiedMarkerNewId,
                "copiedMarkerReconnectCode": copiedMarkerReconnectCode,
                "originalMovePreservedId": originalMovePreservedId,
                "checkDidNotActivate": checkDidNotActivate,
                "missingCode": missingCode, "revokedCode": revokedCode,
                "siblingEscapeCode": siblingEscapeCode, "symlinkEscapeCode": symlinkEscapeCode,
                "accessStarts": self.debugAccessStarts, "accessStops": self.debugAccessStops,
                "accessBalanced": accessBalanced
            ]
        }
    }

    @objc func debugProbe(_ call: CAPPluginCall) {
        perform(call) {
            try self.prepareVault()
            let mode = call.getString("mode") ?? "edit"
            let notePath = "NativeProbeRenamed/Probe.md"
            let binaryPath = "NativeProbeRenamed/Attachment.bin"
            if mode == "verify" {
                let note = String(data: try self.readData(self.validatedURL(notePath)), encoding: .utf8) ?? ""
                let binary = try self.readData(self.validatedURL(binaryPath))
                let pluginEntrypoint = try self.readData(self.validatedURL(".geode/plugins/native-probe/main.js"))
                return [
                    "status": "restored", "adapter": "capacitor-managed-vault", "vault": "managed://default",
                    "note": note, "binaryBase64": binary.base64EncodedString(),
                    "pluginEntrypointBase64": pluginEntrypoint.base64EncodedString(),
                    "pluginRollbackExact": !self.fileManager.fileExists(atPath: try self.validatedURL(".geode/plugins/native-probe/styles.css").path)
                ]
            }

            for path in ["NativeProbe", "NativeProbeRenamed", "CollisionA.md", "CollisionB.md", "TrashProbe.md", "AtomicProbe.md", "BinaryLimit.bin", "BinaryOverLimit.bin", "SymlinkProbe", "RenameDestinationCollision.md", "RenameDestinationCollisionTarget.md", "RenameCancellation.md", "RenameCancellationTarget.md", "RenameDelay.md", "RenameDelayTarget.md", "TrashDestinationCollision.md", "TrashCancellation.md", "TrashDelay.md"] {
                let url = try self.validatedURL(path)
                if self.fileManager.fileExists(atPath: url.path) { try self.fileManager.removeItem(at: url) }
            }
            try self.fileManager.createDirectory(at: self.validatedURL("NativeProbe"), withIntermediateDirectories: false)
            let marker = "# Native managed vault proof\n\nPersisted Swift bytes"
            try self.atomicWrite(Data(marker.utf8), to: self.validatedURL("NativeProbe/Probe.md"))
            try self.atomicWrite(Data([0, 1, 2, 255]), to: self.validatedURL("NativeProbe/Attachment.bin"))
            NSLog("GEODE_MANAGED_PROBE_PHASE initial-rename")
            try self.coordinatedMove(from: self.validatedURL("NativeProbe"), to: self.validatedURL("NativeProbeRenamed"))
            try self.atomicWrite(Data("collision-a".utf8), to: self.validatedURL("CollisionA.md"))
            try self.atomicWrite(Data("collision-b".utf8), to: self.validatedURL("CollisionB.md"))
            var collisionCode = "missing"
            do { try self.coordinatedMove(from: self.validatedURL("CollisionA.md"), to: self.validatedURL("CollisionB.md")) }
            catch let failure as ManagedVaultFailure { collisionCode = failure.code }

            try self.atomicWrite(Data("rename-collision-source".utf8), to: self.validatedURL("RenameDestinationCollision.md"))
            var renameDestinationCollisionCode = "missing"
            do {
                try self.coordinatedMove(
                    from: self.validatedURL("RenameDestinationCollision.md"),
                    to: self.validatedURL("RenameDestinationCollisionTarget.md"),
                    injectDestinationCollision: true
                )
            } catch let failure as ManagedVaultFailure { renameDestinationCollisionCode = failure.code }
            let renameCollisionSourceBytes = try self.readData(self.validatedURL("RenameDestinationCollision.md")).base64EncodedString()
            let renameCollisionDestinationExists = self.fileManager.fileExists(atPath: try self.validatedURL("RenameDestinationCollisionTarget.md").path)

            NSLog("GEODE_MANAGED_PROBE_PHASE rename-cancel")
            try self.atomicWrite(Data("rename-cancel-source".utf8), to: self.validatedURL("RenameCancellation.md"))
            var renameCancellationCode = "missing"
            do {
                try self.coordinatedMove(
                    from: self.validatedURL("RenameCancellation.md"),
                    to: self.validatedURL("RenameCancellationTarget.md"),
                    injectCancellation: true
                )
            } catch let failure as ManagedVaultFailure { renameCancellationCode = failure.code }
            let renameCancellationSourceBytes = try self.readData(self.validatedURL("RenameCancellation.md")).base64EncodedString()

            NSLog("GEODE_MANAGED_PROBE_PHASE rename-delay")
            try self.atomicWrite(Data("rename-delay".utf8), to: self.validatedURL("RenameDelay.md"))
            let renameDelayStarted = Date()
            try self.coordinatedMove(
                from: self.validatedURL("RenameDelay.md"),
                to: self.validatedURL("RenameDelayTarget.md"),
                injectDestinationDelay: true
            )
            let renameDestinationDelayMs = Date().timeIntervalSince(renameDelayStarted) * 1000

            NSLog("GEODE_MANAGED_PROBE_PHASE trash-failures")
            let trashEntriesBeforeFailure = try self.fileManager.contentsOfDirectory(atPath: self.trashRoot.path).count
            try self.atomicWrite(Data("trash-collision-source".utf8), to: self.validatedURL("TrashDestinationCollision.md"))
            var trashDestinationCollisionCode = "missing"
            do {
                _ = try self.moveToTrash(
                    source: self.validatedURL("TrashDestinationCollision.md"),
                    originalPath: "TrashDestinationCollision.md",
                    injectDestinationCollision: true
                )
            } catch let failure as ManagedVaultFailure { trashDestinationCollisionCode = failure.code }
            let trashCollisionSourceBytes = try self.readData(self.validatedURL("TrashDestinationCollision.md")).base64EncodedString()

            try self.atomicWrite(Data("trash-cancel-source".utf8), to: self.validatedURL("TrashCancellation.md"))
            var trashCancellationCode = "missing"
            do {
                _ = try self.moveToTrash(
                    source: self.validatedURL("TrashCancellation.md"),
                    originalPath: "TrashCancellation.md",
                    injectCancellation: true
                )
            } catch let failure as ManagedVaultFailure { trashCancellationCode = failure.code }
            let trashCancellationSourceBytes = try self.readData(self.validatedURL("TrashCancellation.md")).base64EncodedString()
            let trashEntriesAfterFailures = try self.fileManager.contentsOfDirectory(atPath: self.trashRoot.path).count

            NSLog("GEODE_MANAGED_PROBE_PHASE trash-delay")
            try self.atomicWrite(Data("trash-delay".utf8), to: self.validatedURL("TrashDelay.md"))
            let trashDelayStarted = Date()
            _ = try self.moveToTrash(
                source: self.validatedURL("TrashDelay.md"),
                originalPath: "TrashDelay.md",
                injectDestinationDelay: true
            )
            let trashDestinationDelayMs = Date().timeIntervalSince(trashDelayStarted) * 1000
            NSLog("GEODE_MANAGED_PROBE_PHASE validation-atomic")
            var escapeCode = "missing"
            do { _ = try self.validatedURL("../escape.md") }
            catch let failure as ManagedVaultFailure { escapeCode = failure.code }
            var descendantEscapeCode = "missing"
            do { _ = try self.validatedURL("Folder/../escape.md") }
            catch let failure as ManagedVaultFailure { descendantEscapeCode = failure.code }
            var backslashCode = "missing"
            do { _ = try self.validatedURL("Folder\\Escape.md") }
            catch let failure as ManagedVaultFailure { backslashCode = failure.code }

            let atomicURL = try self.validatedURL("AtomicProbe.md")
            try self.atomicWrite(Data("original".utf8), to: atomicURL)
            var atomicFailureCode = "missing"
            do { try self.atomicWrite(Data("replacement".utf8), to: atomicURL, injectPostSwapFailure: true) }
            catch let failure as ManagedVaultFailure { atomicFailureCode = failure.code }
            let atomicOriginalBytes = try self.readData(atomicURL).base64EncodedString()
            let atomicArtifacts = try self.fileManager.contentsOfDirectory(atPath: atomicURL.deletingLastPathComponent().path)
                .filter { $0.hasPrefix(".geode-write-") || $0.hasPrefix(".geode-backup-") }

            let outside = try self.vaultRoot.deletingLastPathComponent().appendingPathComponent("GeodeOutsideProbe", isDirectory: true)
            try? self.fileManager.removeItem(at: outside)
            try self.fileManager.createDirectory(at: outside, withIntermediateDirectories: false)
            let symlink = try self.validatedURL("SymlinkProbe")
            try self.fileManager.createSymbolicLink(at: symlink, withDestinationURL: outside)
            var symlinkEscapeCode = "missing"
            do { _ = try self.validatedURL("SymlinkProbe/Escape.md") }
            catch let failure as ManagedVaultFailure { symlinkEscapeCode = failure.code }
            try? self.fileManager.removeItem(at: symlink)
            try? self.fileManager.removeItem(at: outside)

            let limitURL = try self.validatedURL("BinaryLimit.bin")
            let overLimitURL = try self.validatedURL("BinaryOverLimit.bin")
            try Data(count: self.binaryBridgeLimit).write(to: limitURL)
            try Data(count: self.binaryBridgeLimit + 1).write(to: overLimitURL)
            let binaryLimitBytes = try self.readBinaryData(limitURL).count
            var binaryLimitCode = "missing"
            do { _ = try self.readBinaryData(overLimitURL) }
            catch let failure as ManagedVaultFailure { binaryLimitCode = failure.code }
            try self.fileManager.removeItem(at: limitURL)
            try self.fileManager.removeItem(at: overLimitURL)

            NSLog("GEODE_MANAGED_PROBE_PHASE final-trash")
            try self.atomicWrite(Data("trash".utf8), to: self.validatedURL("TrashProbe.md"))
            let trashRecord = try self.moveToTrash(source: self.validatedURL("TrashProbe.md"), originalPath: "TrashProbe.md")
            let trashPayloadBase64 = try self.readData(trashRecord.appendingPathComponent("payload")).base64EncodedString()
            let trashMetadata = try self.readData(trashRecord.appendingPathComponent("metadata.json"))
            let trashOriginalPath = (try JSONSerialization.jsonObject(with: trashMetadata) as? [String: Any])?["originalPath"] as? String ?? "missing"
            let listedTrash = try self.recursiveEntries().contains { $0.path.hasPrefix(self.trashName) }
            let pluginsRoot = try self.validatedURL(".geode/plugins")
            try self.fileManager.createDirectory(at: pluginsRoot, withIntermediateDirectories: true)
            let nativePluginRoot = try self.validatedURL(".geode/plugins/native-probe")
            try? self.fileManager.removeItem(at: nativePluginRoot)
            try self.fileManager.createDirectory(at: nativePluginRoot, withIntermediateDirectories: false)
            let originalPluginManifest = "{\"id\":\"native-probe\",\"name\":\"Native Probe\",\"version\":\"1.0.0\",\"minAppVersion\":\"0.1.0\",\"isDesktopOnly\":false}"
            let originalPluginMain = "module.exports = class NativeProbe {}"
            try self.atomicWrite(Data(originalPluginManifest.utf8), to: nativePluginRoot.appendingPathComponent("manifest.json"))
            try self.atomicWrite(Data(originalPluginMain.utf8), to: nativePluginRoot.appendingPathComponent("main.js"))
            let pluginIds = try self.installedDirectoryIds(kind: "plugins", requiresManifest: true)
            let updatedPluginManifest = originalPluginManifest.replacingOccurrences(of: "1.0.0", with: "2.0.0")
            try self.atomicReplacePluginFiles(
                id: "native-probe", expectedManifest: originalPluginManifest,
                manifest: updatedPluginManifest, main: "module.exports = class UpdatedProbe {}", styles: ".probe{}"
            )
            try self.atomicReplacePluginFiles(
                id: "native-probe", expectedManifest: updatedPluginManifest,
                manifest: originalPluginManifest, main: originalPluginMain, styles: nil
            )
            var pluginInjectedFailureCode = "missing"
            do {
                try self.atomicReplacePluginFiles(
                    id: "native-probe", expectedManifest: originalPluginManifest,
                    manifest: updatedPluginManifest, main: "bad", styles: "bad",
                    injectBeforeSwapFailure: true
                )
            } catch let failure as ManagedVaultFailure { pluginInjectedFailureCode = failure.code }
            let rollbackManifest = try self.readData(nativePluginRoot.appendingPathComponent("manifest.json"))
            let rollbackMain = try self.readData(nativePluginRoot.appendingPathComponent("main.js"))
            let pluginEntrypointBase64 = rollbackMain.base64EncodedString()
            let pluginRollbackExact = rollbackManifest == Data(originalPluginManifest.utf8) &&
                rollbackMain == Data(originalPluginMain.utf8) &&
                !self.fileManager.fileExists(atPath: nativePluginRoot.appendingPathComponent("styles.css").path)
            return [
                "status": "edited", "adapter": "capacitor-managed-vault", "vault": "managed://default",
                "note": marker, "binaryBase64": Data([0, 1, 2, 255]).base64EncodedString(),
                "escapeCode": escapeCode, "descendantEscapeCode": descendantEscapeCode,
                "backslashCode": backslashCode, "symlinkEscapeCode": symlinkEscapeCode,
                "collisionCode": collisionCode,
                "collisionSource": try self.readData(self.validatedURL("CollisionA.md")).base64EncodedString(),
                "collisionDestination": try self.readData(self.validatedURL("CollisionB.md")).base64EncodedString(),
                "renameDestinationCollisionCode": renameDestinationCollisionCode,
                "renameCollisionSourceBytes": renameCollisionSourceBytes,
                "renameCollisionDestinationExists": renameCollisionDestinationExists,
                "renameCancellationCode": renameCancellationCode,
                "renameCancellationSourceBytes": renameCancellationSourceBytes,
                "renameDestinationDelayMs": renameDestinationDelayMs,
                "trashDestinationCollisionCode": trashDestinationCollisionCode,
                "trashCollisionSourceBytes": trashCollisionSourceBytes,
                "trashCancellationCode": trashCancellationCode,
                "trashCancellationSourceBytes": trashCancellationSourceBytes,
                "trashFailureArtifactsClean": trashEntriesAfterFailures == trashEntriesBeforeFailure,
                "trashDestinationDelayMs": trashDestinationDelayMs,
                "atomicFailureCode": atomicFailureCode, "atomicOriginalBytes": atomicOriginalBytes,
                "atomicArtifacts": atomicArtifacts, "binaryLimitBytes": binaryLimitBytes,
                "binaryLimitCode": binaryLimitCode, "trashPayloadBase64": trashPayloadBase64,
                "trashOriginalPath": trashOriginalPath, "listedTrash": listedTrash,
                "trashExists": self.fileManager.fileExists(atPath: try self.validatedURL("TrashProbe.md").path),
                "pluginIds": pluginIds, "pluginEntrypointBase64": pluginEntrypointBase64,
                "pluginRollbackExact": pluginRollbackExact, "pluginInjectedFailureCode": pluginInjectedFailureCode
            ]
        }
    }
#endif
}

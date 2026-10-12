import Darwin
import Foundation

/// Sync-private storage in the app sandbox, outside every vault: frozen blobs, operation journals and recovery
/// receipts for guarded sync. Nothing here is ever scanned, listed, uploaded or synced, and the root is excluded
/// from device backups. Paths are relative, `/`-separated, and may not climb out of the root.
final class GeodeSyncPrivateStore {
    enum StoreError: Error, Equatable { case invalidPath, tooLarge, io }

    let root: URL
    let byteLimit: Int
    private let fileManager = FileManager.default

    init(root: URL, byteLimit: Int = 32 * 1024 * 1024) {
        self.root = root.standardizedFileURL
        self.byteLimit = byteLimit
    }

    static func defaultRoot() throws -> URL {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw StoreError.io }
        return support.appendingPathComponent("GeodeSyncPrivate", isDirectory: true)
    }

    private func components(_ path: String) throws -> [String] {
        guard !path.isEmpty, !path.contains("\0"), !path.contains("\\"), !path.hasPrefix("/") else { throw StoreError.invalidPath }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 }) else { throw StoreError.invalidPath }
        return parts
    }

    private func url(_ path: String) throws -> URL {
        var candidate = root
        for part in try components(path) { candidate.appendPathComponent(part, isDirectory: false) }
        return candidate
    }

    private func ensureRoot() throws {
        if !fileManager.fileExists(atPath: root.path) {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = root
        try mutableRoot.setResourceValues(values)
    }

    private func syncDirectory(_ directory: URL) throws {
        let descriptor = open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw StoreError.io }
        defer { close(descriptor) }
        guard fsync(descriptor) == 0 else { throw StoreError.io }
    }

    /// Durable and atomic: temp file in the same directory, fsync, rename over the target, fsync the directory.
    func write(_ data: Data, to path: String) throws {
        guard data.count <= byteLimit else { throw StoreError.tooLarge }
        try ensureRoot()
        let target = try url(path)
        let parent = target.deletingLastPathComponent()
        if !fileManager.fileExists(atPath: parent.path) {
            try fileManager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: target.path, isDirectory: &isDirectory), isDirectory.boolValue { throw StoreError.invalidPath }
        let temporary = parent.appendingPathComponent("\(target.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            guard fileManager.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw StoreError.io }
            let handle = try FileHandle(forWritingTo: temporary)
            do {
                try handle.write(contentsOf: data)
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            guard rename(temporary.path, target.path) == 0 else { throw StoreError.io }
            try syncDirectory(parent)
        } catch {
            try? fileManager.removeItem(at: temporary)
            throw error
        }
    }

    func read(_ path: String) throws -> Data? {
        let target = try url(path)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: target.path, isDirectory: &isDirectory) else { return nil }
        guard !isDirectory.boolValue else { throw StoreError.invalidPath }
        let attributes = try fileManager.attributesOfItem(atPath: target.path)
        guard ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= byteLimit else { throw StoreError.tooLarge }
        return try Data(contentsOf: target)
    }

    func list(_ path: String) throws -> [(name: String, isFolder: Bool)] {
        let directory = try url(path)
        guard fileManager.fileExists(atPath: directory.path) else { return [] }
        return try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey]).map { child in
            (name: child.lastPathComponent, isFolder: (try? child.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true)
        }.sorted { $0.name < $1.name }
    }

    /// Idempotent. A non-recursive remove of a directory is refused rather than silently emptying it.
    func remove(_ path: String, recursive: Bool) throws {
        let target = try url(path)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: target.path, isDirectory: &isDirectory) else { return }
        if isDirectory.boolValue && !recursive { throw StoreError.invalidPath }
        try fileManager.removeItem(at: target)
        try syncDirectory(target.deletingLastPathComponent())
    }

    func availableBytes() throws -> Int64 {
        try ensureRoot()
        let values = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values.volumeAvailableCapacityForImportantUsage ?? 0
    }
}

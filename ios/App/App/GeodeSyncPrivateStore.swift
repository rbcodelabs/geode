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

    /// `maxBytes` lets a caller with a smaller transport limit than the store's refuse a large file before loading it.
    func read(_ path: String, maxBytes: Int? = nil) throws -> Data? {
        let target = try url(path)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: target.path, isDirectory: &isDirectory) else { return nil }
        guard !isDirectory.boolValue else { throw StoreError.invalidPath }
        let attributes = try fileManager.attributesOfItem(atPath: target.path)
        guard ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= min(byteLimit, maxBytes ?? byteLimit) else { throw StoreError.tooLarge }
        return try Data(contentsOf: target)
    }

    /// Up to `length` bytes at `offset` plus the file's whole size; nil when absent.
    func readRange(_ path: String, offset: Int, length: Int) throws -> (data: Data, size: Int)? {
        let target = try url(path)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: target.path, isDirectory: &isDirectory) else { return nil }
        guard !isDirectory.boolValue else { throw StoreError.invalidPath }
        let size = ((try fileManager.attributesOfItem(atPath: target.path))[.size] as? NSNumber)?.intValue ?? 0
        guard size <= byteLimit else { throw StoreError.tooLarge }
        let handle = try FileHandle(forReadingFrom: target)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return (try handle.read(upToCount: length) ?? Data(), size)
    }

    /// Chunked counterpart of `write`: the same durable temp-fsync-rename, assembled over several calls in `<name>.chunked.tmp`
    /// (a `.tmp` name, so startup GC reclaims an abandoned one). Offset 0 starts afresh; any other offset must equal the temp's size.
    func writeChunk(_ data: Data, to path: String, offset: Int, final: Bool) throws {
        guard offset >= 0, offset + data.count <= byteLimit else { throw StoreError.tooLarge }
        try ensureRoot()
        let target = try url(path)
        let parent = target.deletingLastPathComponent()
        if !fileManager.fileExists(atPath: parent.path) {
            try fileManager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: target.path, isDirectory: &isDirectory), isDirectory.boolValue { throw StoreError.invalidPath }
        let temporary = parent.appendingPathComponent("\(target.lastPathComponent).chunked.tmp")
        do {
            if offset == 0 {
                try? fileManager.removeItem(at: temporary)
                guard fileManager.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw StoreError.io }
            } else {
                let size = ((try? fileManager.attributesOfItem(atPath: temporary.path))?[.size] as? NSNumber)?.intValue
                guard size == offset else { throw StoreError.io }
            }
            let handle = try FileHandle(forWritingTo: temporary)
            do {
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                if final { try handle.synchronize() }
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            if final {
                guard rename(temporary.path, target.path) == 0 else { throw StoreError.io }
                try syncDirectory(parent)
            }
        } catch {
            try? fileManager.removeItem(at: temporary)
            throw error
        }
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

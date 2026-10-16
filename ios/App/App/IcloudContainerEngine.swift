import CryptoKit
import Darwin
import Foundation

// Pure engine behind the `GeodeIcloudContainer` Capacitor plugin (ADR 0030, iOS side). It implements the primitives of
// `src/shared/icloud-container.ts` over a `Documents/` directory URL and has NO Capacitor import, so the XCTests drive it
// against a temp directory with a fake coordinator. Policy (marker, ops, trash layout, conflict-copy names) stays in the
// one TypeScript provider; nothing here decides what a sync means.
//
// Fail-closed rules: a symlink, a special file, an unresolved NSFileVersion conflict or an unreadable folder is never
// silently dropped; it either fails the call (`precondition-failed`) or is reported as a walk problem.

// MARK: - Errors and wire types

struct IcloudBridgeFailure: Error, Equatable {
    enum Code: String {
        case preconditionFailed = "precondition-failed"
        case notFound = "not-found"
        case unavailable
        case aborted
        case tooLarge = "too-large"
        case invalidPath = "invalid-path"
        case failed
    }

    let code: Code
    let message: String

    static func failed(_ message: String) -> IcloudBridgeFailure { .init(code: .failed, message: message) }
    static func precondition(_ message: String) -> IcloudBridgeFailure { .init(code: .preconditionFailed, message: message) }
    static let aborted = IcloudBridgeFailure(code: .aborted, message: "The operation was aborted")
}

enum IcloudItemAvailability: String {
    case current
    case notDownloaded = "not-downloaded"
}

enum IcloudItemKind: String {
    case file, folder, symlink, other
}

struct IcloudStat: Equatable {
    var kind: IcloudItemKind
    var size: Int
    var mtimeMs: Double
    var revision: String
    var availability: IcloudItemAvailability

    var wire: [String: Any] {
        ["kind": kind.rawValue, "size": size, "mtimeMs": mtimeMs, "revision": revision, "availability": availability.rawValue]
    }
}

struct IcloudListEntry: Equatable {
    var name: String
    var kind: IcloudItemKind
    var availability: IcloudItemAvailability

    var wire: [String: Any] { ["name": name, "kind": kind.rawValue, "availability": availability.rawValue] }
}

struct IcloudWalkEntry: Equatable {
    var path: String
    var stat: IcloudStat

    var wire: [String: Any] {
        var out = stat.wire
        out["path"] = path
        return out
    }
}

struct IcloudWalkProblem: Equatable {
    enum Code: String { case symlink, unreadable, unsupported }
    var code: Code
    var message: String

    var wire: [String: Any] { ["code": code.rawValue, "message": message] }
}

struct IcloudWalkOptions {
    var skipNames: Set<String> = []
    var skipPrefixes: [String] = []
    var skipTopLevel: Set<String> = []
    var maxHashBytes: Int
}

struct IcloudReadRange {
    var offset: Int = 0
    var length: Int?
    var expectedRevision: String?
    var maxBytes: Int?
}

enum IcloudWritePrecondition: Equatable {
    case absent
    case revision(String)
    case any
}

/// Cooperative cancellation. The plugin flips it from `abort(requestId)`; long loops poll it.
final class IcloudCancelToken {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func check() throws { if isCancelled { throw IcloudBridgeFailure.aborted } }
}

// MARK: - Seams

/// All coordinated file access goes through this seam. The system implementation wraps `NSFileCoordinator`; tests use a
/// fake that records calls and can run a hook (a "concurrent writer") immediately before the accessor.
protocol IcloudFileCoordinating {
    func coordinatedRead<T>(at url: URL, _ body: (URL) throws -> T) throws -> T
    func coordinatedWrite<T>(at url: URL, replacing: Bool, _ body: (URL) throws -> T) throws -> T
    func coordinatedMove<T>(from source: URL, to destination: URL, _ body: (URL, URL) throws -> T) throws -> T
}

/// Everything the engine asks iCloud about an item. Outside an iCloud container (tests) every item is current and
/// conflict-free.
protocol IcloudUbiquityInspecting {
    func downloadState(of url: URL) -> IcloudItemAvailability
    func hasUnresolvedConflicts(at url: URL) -> Bool
    func startDownloading(at url: URL) throws
}

struct SystemIcloudFileCoordinator: IcloudFileCoordinating {
    func coordinatedRead<T>(at url: URL, _ body: (URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var outcome: Result<T, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { granted in
            outcome = Result { try body(granted) }
        }
        return try finish(outcome, coordinationError)
    }

    func coordinatedWrite<T>(at url: URL, replacing: Bool, _ body: (URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var outcome: Result<T, Error>?
        coordinator.coordinate(writingItemAt: url, options: replacing ? .forReplacing : [], error: &coordinationError) { granted in
            outcome = Result { try body(granted) }
        }
        return try finish(outcome, coordinationError)
    }

    func coordinatedMove<T>(from source: URL, to destination: URL, _ body: (URL, URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var outcome: Result<T, Error>?
        coordinator.coordinate(writingItemAt: source, options: .forMoving, writingItemAt: destination, options: .forReplacing, error: &coordinationError) { grantedSource, grantedDestination in
            outcome = Result { try body(grantedSource, grantedDestination) }
        }
        return try finish(outcome, coordinationError)
    }

    private func finish<T>(_ outcome: Result<T, Error>?, _ coordinationError: NSError?) throws -> T {
        if let coordinationError { throw IcloudBridgeFailure.failed("File coordination failed: \(coordinationError.localizedDescription)") }
        guard let outcome else { throw IcloudBridgeFailure.failed("File coordination did not run") }
        return try outcome.get()
    }
}

struct SystemIcloudUbiquity: IcloudUbiquityInspecting {
    func downloadState(of url: URL) -> IcloudItemAvailability {
        let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
        // nil: not a ubiquitous item (or unknown), so the bytes are whatever is on disk.
        return values?.ubiquitousItemDownloadingStatus == .notDownloaded ? .notDownloaded : .current
    }

    func hasUnresolvedConflicts(at url: URL) -> Bool {
        if (try? url.resourceValues(forKeys: [.ubiquitousItemHasUnresolvedConflictsKey]))?.ubiquitousItemHasUnresolvedConflicts == true { return true }
        return !(NSFileVersion.unresolvedConflictVersionsOfItem(at: url) ?? []).isEmpty
    }

    func startDownloading(at url: URL) throws {
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
    }
}

// MARK: - Container resolution

/// Resolves `Documents/` of the ubiquity container. Pure over its closures so the failure mapping is testable. It
/// creates `Documents/` (iOS owns that: the Mac mirror directory only shows it once an iOS device has made it) but
/// never anything above a root folder.
struct IcloudContainerResolver {
    enum Resolution: Equatable {
        case available(URL)
        case unavailable(reason: String, message: String)
    }

    var hasIdentityToken: () -> Bool = { FileManager.default.ubiquityIdentityToken != nil }
    var containerURL: () -> URL? = { FileManager.default.url(forUbiquityContainerIdentifier: IcloudContainerEngine.containerId) }

    /// Blocks (the system call can block on first use): call off the main thread.
    func resolve() -> Resolution {
        guard hasIdentityToken() else {
            return .unavailable(reason: "not-signed-in", message: "Sign in to iCloud and turn on iCloud Drive for Geode in Settings.")
        }
        guard let container = containerURL() else {
            return .unavailable(reason: "container-not-found", message: "Geode's iCloud container (\(IcloudContainerEngine.containerId)) is not available. Check that iCloud Drive is on for Geode in Settings.")
        }
        let documents = container.appendingPathComponent("Documents", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
        } catch {
            return .unavailable(reason: "permission-denied", message: "Geode could not open its iCloud Documents folder: \(error.localizedDescription)")
        }
        return .available(documents)
    }
}

// MARK: - Engine

struct IcloudContainerEngine {
    static let containerId = "iCloud.com.rbcodelabs.geode"
    static let tempPrefix = ".geode-tmp-"
    /// A whole-file read without a range never exceeds this (the provider reads larger files in ranges).
    static let wholeReadLimit = 100 * 1024 * 1024

    let documents: URL
    let coordinator: IcloudFileCoordinating
    let ubiquity: IcloudUbiquityInspecting
    private let state = EngineState()

    init(documents: URL, coordinator: IcloudFileCoordinating = SystemIcloudFileCoordinator(), ubiquity: IcloudUbiquityInspecting = SystemIcloudUbiquity()) {
        self.documents = documents
        self.coordinator = coordinator
        self.ubiquity = ubiquity
    }

    // MARK: Path handling

    private struct Resolved {
        let url: URL
        let rootURL: URL
        let rootReal: String
    }

    private func checkRoot(_ root: String) throws -> String {
        let nfc = root.precomposedStringWithCanonicalMapping
        if nfc.isEmpty || nfc.contains("\0") || nfc.contains("/") || nfc.contains("\\") || nfc == "." || nfc == ".." || nfc.hasPrefix(".") || nfc.utf8.count > 255 {
            throw IcloudBridgeFailure(code: .invalidPath, message: "Invalid iCloud root folder: \(root)")
        }
        return nfc
    }

    private func checkRelative(_ path: String) throws -> [String] {
        if path.isEmpty { return [] }
        let nfc = path.precomposedStringWithCanonicalMapping
        if nfc.contains("\0") || nfc.hasPrefix("/") || nfc.contains("\\") { throw IcloudBridgeFailure(code: .invalidPath, message: "Invalid iCloud path: \(path)") }
        let parts = nfc.components(separatedBy: "/")
        if parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.utf8.count > 255 }) {
            throw IcloudBridgeFailure(code: .invalidPath, message: "Invalid iCloud path: \(path)")
        }
        return parts
    }

    private static func realPath(_ path: String) -> (path: String?, errno: Int32) {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(path, &buffer) != nil else { return (nil, errno) }
        return (String(cString: buffer), 0)
    }

    private static func isInside(_ candidate: String, _ root: String) -> Bool {
        candidate == root || candidate.hasPrefix(root + "/")
    }

    /// Absolute URL for `path` under `root`, after proving no symlink on the way leads outside the root folder.
    private func resolve(_ root: String, _ path: String) throws -> Resolved {
        let rootName = try checkRoot(root)
        let parts = try checkRelative(path)
        let documentsReal = Self.realPath(documents.path)
        guard let documentsRealPath = documentsReal.path else { throw IcloudBridgeFailure(code: .unavailable, message: "The iCloud Documents folder is not available") }
        let rootURL = documents.appendingPathComponent(rootName, isDirectory: true)
        let rootResolved = Self.realPath(rootURL.path)
        guard let rootReal = rootResolved.path else {
            if rootResolved.errno == ENOENT { throw IcloudBridgeFailure(code: .notFound, message: "iCloud folder \"\(root)\" does not exist") }
            throw IcloudBridgeFailure.failed("Cannot resolve iCloud folder \"\(root)\" (errno \(rootResolved.errno))")
        }
        if (rootReal as NSString).deletingLastPathComponent != documentsRealPath {
            throw IcloudBridgeFailure(code: .invalidPath, message: "\"\(root)\" resolves outside the iCloud container")
        }
        var url = rootURL
        for part in parts { url.appendPathComponent(part) }
        // The deepest existing ancestor of the target must still be inside the root.
        var probe = parts.isEmpty ? url.path : (url.path as NSString).deletingLastPathComponent
        while true {
            let resolved = Self.realPath(probe)
            if let real = resolved.path {
                if !Self.isInside(real, rootReal) { throw IcloudBridgeFailure(code: .invalidPath, message: "\(path.isEmpty ? root : path) resolves outside the iCloud folder") }
                break
            }
            guard resolved.errno == ENOENT else { throw IcloudBridgeFailure.failed("Cannot resolve \(path) (errno \(resolved.errno))") }
            let parent = (probe as NSString).deletingLastPathComponent
            if parent == probe || parent.isEmpty { throw IcloudBridgeFailure.failed("Cannot resolve \(path)") }
            probe = parent
        }
        return Resolved(url: url, rootURL: rootURL, rootReal: rootReal)
    }

    private func ensureParentInsideRoot(of url: URL, rootReal: String, display: String) throws {
        let parent = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        guard let real = Self.realPath(parent.path).path, Self.isInside(real, rootReal) else {
            throw IcloudBridgeFailure(code: .invalidPath, message: "\(display) resolves outside the iCloud folder")
        }
    }

    // MARK: Low-level file facts

    private struct FileInfo {
        var mode: mode_t
        var size: Int
        var device: Int64
        var inode: UInt64
        var mtimeNs: Int64
        var ctimeNs: Int64

        var isDirectory: Bool { mode & S_IFMT == S_IFDIR }
        var isRegular: Bool { mode & S_IFMT == S_IFREG }
        var isSymlink: Bool { mode & S_IFMT == S_IFLNK }
        var mtimeMs: Double { Double(mtimeNs) / 1_000_000 }
        var cacheKey: String { "\(device):\(inode):\(mtimeNs):\(ctimeNs):\(size)" }
    }

    private func lstatInfo(_ url: URL) throws -> FileInfo? {
        var info = Darwin.stat()
        if lstat(url.path, &info) != 0 {
            if errno == ENOENT || errno == ENOTDIR { return nil }
            throw IcloudBridgeFailure.failed("Cannot stat \(url.lastPathComponent) (errno \(errno))")
        }
        let mtimeSeconds = Int64(info.st_mtimespec.tv_sec)
        let mtimeNanos = Int64(info.st_mtimespec.tv_nsec)
        let ctimeSeconds = Int64(info.st_ctimespec.tv_sec)
        let ctimeNanos = Int64(info.st_ctimespec.tv_nsec)
        let nanosPerSecond: Int64 = 1_000_000_000
        return FileInfo(
            mode: info.st_mode,
            size: Int(info.st_size),
            device: Int64(info.st_dev),
            inode: UInt64(info.st_ino),
            mtimeNs: mtimeSeconds * nanosPerSecond + mtimeNanos,
            ctimeNs: ctimeSeconds * nanosPerSecond + ctimeNanos
        )
    }

    private func stubURL(for url: URL) -> URL {
        url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    }

    private static func stubTarget(_ name: String) -> String? {
        guard name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > ".icloud".count + 1 else { return nil }
        return String(name.dropFirst().dropLast(".icloud".count))
    }

    private func revision(_ info: FileInfo, sha: String) -> String {
        "\(info.mtimeNs / 1_000_000):\(info.size):\(sha)"
    }

    private func sha256(of handle: FileHandle, cancel: IcloudCancelToken?) throws -> String {
        var hasher = SHA256()
        while true {
            try cancel?.check()
            guard let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty else { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Hash straight from disk, no cache, no coordination (callers already hold the coordination they need).
    private func hashFile(_ url: URL, cancel: IcloudCancelToken? = nil) throws -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { throw IcloudBridgeFailure.failed("Cannot read \(url.lastPathComponent)") }
        defer { try? handle.close() }
        return try sha256(of: handle, cancel: cancel)
    }

    // MARK: Availability, roots

    func listRoots(cancel: IcloudCancelToken? = nil) throws -> [String] {
        try cancel?.check()
        let names: [String]
        do { names = try FileManager.default.contentsOfDirectory(atPath: documents.path) }
        catch { throw IcloudBridgeFailure.failed("Cannot read the iCloud container: \(error.localizedDescription)") }
        var roots: [String] = []
        for name in names where !name.hasPrefix(".") {
            if let info = try lstatInfo(documents.appendingPathComponent(name)), info.isDirectory { roots.append(name.precomposedStringWithCanonicalMapping) }
        }
        return roots.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    // MARK: list / stat / walk

    func list(root: String, path: String, cancel: IcloudCancelToken? = nil) throws -> [IcloudListEntry]? {
        let resolved: Resolved
        do { resolved = try resolve(root, path) }
        catch let failure as IcloudBridgeFailure where failure.code == .notFound { return nil }
        try cancel?.check()
        let names: [String]
        do { names = try FileManager.default.contentsOfDirectory(atPath: resolved.url.path) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError) { return nil }
        catch { throw IcloudBridgeFailure.failed("Cannot list \(path.isEmpty ? root : path): \(error.localizedDescription)") }
        let real = Set(names.map { $0.precomposedStringWithCanonicalMapping })
        var out: [IcloudListEntry] = []
        for raw in names {
            try cancel?.check()
            let name = raw.precomposedStringWithCanonicalMapping
            if let target = Self.stubTarget(name) {
                // An evicted file is reported under its real name; a real sibling of the same name wins.
                if !real.contains(target.precomposedStringWithCanonicalMapping) { out.append(IcloudListEntry(name: target.precomposedStringWithCanonicalMapping, kind: .file, availability: .notDownloaded)) }
                continue
            }
            let url = resolved.url.appendingPathComponent(raw)
            guard let info = try lstatInfo(url) else { continue }
            let kind: IcloudItemKind = info.isSymlink ? .symlink : info.isDirectory ? .folder : info.isRegular ? .file : .other
            let availability: IcloudItemAvailability = kind == .file ? ubiquity.downloadState(of: url) : .current
            out.append(IcloudListEntry(name: name, kind: kind, availability: availability))
        }
        return out
    }

    func stat(root: String, path: String, maxHashBytes: Int, cancel: IcloudCancelToken? = nil) throws -> IcloudStat? {
        let resolved: Resolved
        do { resolved = try resolve(root, path) }
        catch let failure as IcloudBridgeFailure where failure.code == .notFound { return nil }
        return try statAt(resolved.url, maxHashBytes: maxHashBytes, useCache: false, cancel: cancel)
    }

    /// nil when neither the file nor its stub exists. A symlink, special file or conflicted file is a precondition failure.
    private func statAt(_ url: URL, maxHashBytes: Int, useCache: Bool, cancel: IcloudCancelToken?) throws -> IcloudStat? {
        guard let info = try lstatInfo(url) else {
            return try lstatInfo(stubURL(for: url)) != nil ? IcloudStat(kind: .file, size: 0, mtimeMs: 0, revision: "", availability: .notDownloaded) : nil
        }
        if info.isDirectory { return IcloudStat(kind: .folder, size: 0, mtimeMs: info.mtimeMs, revision: Self.folderRevision, availability: .current) }
        guard info.isRegular else { throw IcloudBridgeFailure.precondition("\(url.lastPathComponent) is not a regular file or folder") }
        if ubiquity.hasUnresolvedConflicts(at: url) { throw IcloudBridgeFailure.precondition("\(url.lastPathComponent) has unresolved iCloud conflict versions") }
        if ubiquity.downloadState(of: url) == .notDownloaded { return IcloudStat(kind: .file, size: info.size, mtimeMs: info.mtimeMs, revision: "", availability: .notDownloaded) }
        if info.size > maxHashBytes { return IcloudStat(kind: .file, size: info.size, mtimeMs: info.mtimeMs, revision: revision(info, sha: "-"), availability: .current) }
        let key = info.cacheKey
        let sha: String
        if useCache, let cached = state.cachedHash(for: url.path, key: key) {
            sha = cached
        } else {
            sha = try coordinator.coordinatedRead(at: url) { try hashFile($0, cancel: cancel) }
            state.storeHash(sha, for: url.path, key: key)
        }
        return IcloudStat(kind: .file, size: info.size, mtimeMs: info.mtimeMs, revision: revision(info, sha: sha), availability: .current)
    }

    static let folderRevision = "folder"

    func walk(root: String, path: String, options: IcloudWalkOptions, cancel: IcloudCancelToken? = nil) throws -> (entries: [IcloudWalkEntry], problems: [IcloudWalkProblem]) {
        let start = try resolve(root, path).url
        var entries: [IcloudWalkEntry] = []
        var problems: [IcloudWalkProblem] = []
        var seen = Set<String>()

        func skipped(_ name: String, topLevel: Bool) -> Bool {
            options.skipNames.contains(name) || options.skipPrefixes.contains(where: { name.hasPrefix($0) }) || (topLevel && options.skipTopLevel.contains(name))
        }

        func visit(_ directory: URL, _ relative: String) throws {
            try cancel?.check()
            let names: [String]
            do { names = try FileManager.default.contentsOfDirectory(atPath: directory.path) }
            catch {
                problems.append(IcloudWalkProblem(code: .unreadable, message: "readdir \(relative.isEmpty ? "." : relative): \(error.localizedDescription)"))
                return
            }
            let rawNames = Set(names)
            for raw in names {
                try cancel?.check()
                let stubName = Self.stubTarget(raw)
                if let stubName, rawNames.contains(stubName) { continue } // the real file is here; the stub is stale
                let logical = (stubName ?? raw).precomposedStringWithCanonicalMapping
                if skipped(logical, topLevel: relative.isEmpty) { continue }
                let childRelative = relative.isEmpty ? logical : "\(relative)/\(logical)"
                if stubName != nil {
                    entries.append(IcloudWalkEntry(path: childRelative, stat: IcloudStat(kind: .file, size: 0, mtimeMs: 0, revision: "", availability: .notDownloaded)))
                    continue
                }
                let url = directory.appendingPathComponent(raw)
                let info: FileInfo?
                do { info = try lstatInfo(url) }
                catch {
                    problems.append(IcloudWalkProblem(code: .unreadable, message: "stat \(childRelative): \(error.localizedDescription)"))
                    continue
                }
                guard let info else {
                    // Vanishing mid-walk is expected under iCloud; it must never read as a deletion.
                    problems.append(IcloudWalkProblem(code: .unreadable, message: "stat \(childRelative): disappeared during the scan"))
                    continue
                }
                if info.isSymlink {
                    problems.append(IcloudWalkProblem(code: .symlink, message: "symlink \(childRelative)"))
                } else if info.isDirectory {
                    entries.append(IcloudWalkEntry(path: childRelative, stat: IcloudStat(kind: .folder, size: 0, mtimeMs: 0, revision: Self.folderRevision, availability: .current)))
                    try visit(url, childRelative)
                } else if !info.isRegular {
                    problems.append(IcloudWalkProblem(code: .unsupported, message: "unsupported file type \(childRelative)"))
                } else {
                    do {
                        guard let stat = try statAt(url, maxHashBytes: options.maxHashBytes, useCache: true, cancel: cancel) else {
                            problems.append(IcloudWalkProblem(code: .unreadable, message: "stat \(childRelative): disappeared during the scan"))
                            continue
                        }
                        seen.insert(url.path)
                        entries.append(IcloudWalkEntry(path: childRelative, stat: stat))
                    } catch let failure as IcloudBridgeFailure where failure.code == .aborted {
                        throw failure
                    } catch let failure as IcloudBridgeFailure {
                        // Includes unresolved conflicts: the file is withheld and the scan is partial, never silently complete.
                        problems.append(IcloudWalkProblem(code: .unreadable, message: "stat \(childRelative): \(failure.message)"))
                    }
                }
            }
        }

        try visit(start, "")
        state.pruneHashes(under: start.path, keeping: seen)
        return (entries, problems)
    }

    // MARK: read

    func read(root: String, path: String, range: IcloudReadRange, cancel: IcloudCancelToken? = nil) throws -> (data: Data, revision: String) {
        let resolved = try resolve(root, path)
        let url = resolved.url
        guard let info = try lstatInfo(url) else {
            if try lstatInfo(stubURL(for: url)) != nil { throw IcloudBridgeFailure(code: .unavailable, message: "\(path) is stored in iCloud and has not finished downloading") }
            throw IcloudBridgeFailure(code: .notFound, message: "\(path) does not exist")
        }
        guard info.isRegular else { throw IcloudBridgeFailure.failed("\(path) is not a file") }
        if ubiquity.hasUnresolvedConflicts(at: url) { throw IcloudBridgeFailure.precondition("\(path) has unresolved iCloud conflict versions") }
        // Checked before coordinating: a coordinated read of an evicted file would block on the download.
        if ubiquity.downloadState(of: url) == .notDownloaded { throw IcloudBridgeFailure(code: .unavailable, message: "\(path) is stored in iCloud and has not finished downloading") }
        if let maxBytes = range.maxBytes, info.size > maxBytes { throw IcloudBridgeFailure(code: .tooLarge, message: "\(path) exceeds the \(maxBytes)-byte limit") }
        let whole = range.offset == 0 && range.length == nil
        if whole && info.size > Self.wholeReadLimit { throw IcloudBridgeFailure(code: .tooLarge, message: "\(path) is too large to read in one call") }
        if range.offset < 0 || (range.length ?? 0) < 0 { throw IcloudBridgeFailure.failed("Invalid read range") }

        return try coordinator.coordinatedRead(at: url) { granted in
            try cancel?.check()
            // Re-stat inside the coordination: the revision must describe the bytes we hand back.
            guard let current = try lstatInfo(granted), current.isRegular else { throw IcloudBridgeFailure(code: .notFound, message: "\(path) does not exist") }
            guard let handle = try? FileHandle(forReadingFrom: granted) else { throw IcloudBridgeFailure.failed("Cannot read \(path)") }
            defer { try? handle.close() }
            var revisionValue = ""
            var data: Data
            if whole {
                data = try handle.readToEnd() ?? Data()
                var hasher = SHA256()
                hasher.update(data: data)
                revisionValue = revision(current, sha: hasher.finalize().map { String(format: "%02x", $0) }.joined())
            } else {
                if range.expectedRevision != nil {
                    // A ranged read can only vouch for the file if the whole file still hashes to what the caller listed.
                    revisionValue = revision(current, sha: try sha256(of: handle, cancel: cancel))
                }
                let length = min(range.length ?? current.size, max(0, current.size - range.offset))
                try handle.seek(toOffset: UInt64(range.offset))
                data = length > 0 ? (try handle.read(upToCount: length) ?? Data()) : Data()
            }
            // Return what the caller asked for or fail: bytes under a different revision would poison its baseline.
            if let expected = range.expectedRevision, revisionValue != expected {
                throw IcloudBridgeFailure.precondition("Remote file \(path) changed since it was listed")
            }
            return (data, revisionValue)
        }
    }

    // MARK: staged conditional writes

    func beginWrite(root: String, path: String) throws -> String {
        let resolved = try resolve(root, path)
        if try checkRelative(path).isEmpty { throw IcloudBridgeFailure(code: .invalidPath, message: "Cannot write the root folder") }
        try ensureParentInsideRoot(of: resolved.url, rootReal: resolved.rootReal, display: path)
        let temp = resolved.url.deletingLastPathComponent().appendingPathComponent("\(Self.tempPrefix)\(UUID().uuidString)")
        let descriptor = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, 0o644)
        guard descriptor >= 0 else { throw IcloudBridgeFailure.failed("Cannot stage a write for \(path) (errno \(errno))") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        return state.addStaged(StagedWrite(handle: handle, temp: temp, destination: resolved.url, display: path))
    }

    func appendChunk(handle id: String, data: Data) throws {
        guard let staged = state.staged(id), let handle = staged.handle else {
            throw IcloudBridgeFailure.failed("Unknown or finished write handle")
        }
        do { try handle.write(contentsOf: data) }
        catch {
            discardWrite(handle: id)
            throw IcloudBridgeFailure.failed("Staged write failed: \(error.localizedDescription)")
        }
    }

    func commitWrite(handle id: String, precondition: IcloudWritePrecondition, maxHashBytes: Int, cancel: IcloudCancelToken? = nil) throws -> IcloudStat {
        guard let staged = state.staged(id) else { throw IcloudBridgeFailure.failed("Unknown or finished write handle") }
        do {
            try cancel?.check()
            try staged.handle?.synchronize()
            try staged.handle?.close()
            state.markClosed(id)
            try coordinator.coordinatedWrite(at: staged.destination, replacing: precondition != .absent) { destination in
                try cancel?.check()
                switch precondition {
                case .absent:
                    // Create-only: renamex_np(RENAME_EXCL) publishes the bytes only if the name is free, so an existing target is never replaced.
                    if try lstatInfo(stubURL(for: destination)) != nil { throw IcloudBridgeFailure.precondition("\(destination.lastPathComponent) already exists (not downloaded)") }
                    try renameExclusive(staged.temp, destination)
                case .revision(let expected):
                    // Verified inside the coordination: a coordinated writer (including iCloud's daemon) cannot slip in between this and the replace.
                    try verifyRevision(destination, expected: expected, maxHashBytes: maxHashBytes)
                    try replace(destination, with: staged.temp)
                case .any:
                    if try lstatInfo(destination) != nil { try replace(destination, with: staged.temp) }
                    else { try renameExclusive(staged.temp, destination) }
                }
            }
            state.removeStaged(id)
            guard let stat = try statAt(staged.destination, maxHashBytes: maxHashBytes, useCache: false, cancel: cancel) else {
                throw IcloudBridgeFailure.failed("The file disappeared right after it was written")
            }
            return stat
        } catch {
            discardWrite(handle: id)
            throw error as? IcloudBridgeFailure ?? IcloudBridgeFailure.failed(error.localizedDescription)
        }
    }

    func discardWrite(handle id: String) {
        guard let staged = state.removeStaged(id) else { return }
        try? staged.handle?.close()
        try? FileManager.default.removeItem(at: staged.temp)
    }

    /// Drop every staged write (a new WebView session cannot reach the old handles).
    func discardAllWrites() {
        for id in state.stagedIds() { discardWrite(handle: id) }
    }

    private func replace(_ destination: URL, with temp: URL) throws {
        do { _ = try FileManager.default.replaceItemAt(destination, withItemAt: temp) }
        catch { throw IcloudBridgeFailure.failed("Could not replace \(destination.lastPathComponent): \(error.localizedDescription)") }
    }

    private func renameExclusive(_ from: URL, _ to: URL) throws {
        if renamex_np(from.path, to.path, UInt32(RENAME_EXCL)) != 0 {
            if errno == EEXIST { throw IcloudBridgeFailure.precondition("\(to.lastPathComponent) already exists") }
            throw IcloudBridgeFailure.failed("Could not publish \(to.lastPathComponent) (errno \(errno))")
        }
    }

    /// Re-derive the revision from disk bytes (never from cache) and compare.
    private func verifyRevision(_ url: URL, expected: String, maxHashBytes: Int) throws {
        let name = url.lastPathComponent
        guard let info = try lstatInfo(url) else { throw IcloudBridgeFailure.precondition("\(name) no longer exists") }
        let actual: String
        if info.isDirectory {
            actual = Self.folderRevision
        } else if info.isRegular {
            if ubiquity.hasUnresolvedConflicts(at: url) { throw IcloudBridgeFailure.precondition("\(name) has unresolved iCloud conflict versions") }
            if ubiquity.downloadState(of: url) == .notDownloaded { throw IcloudBridgeFailure.precondition("\(name) is not downloaded") }
            actual = revision(info, sha: info.size > maxHashBytes ? "-" : try hashFile(url))
        } else {
            throw IcloudBridgeFailure.precondition("\(name) is not a regular file")
        }
        if actual != expected { throw IcloudBridgeFailure.precondition("\(name) changed (expected \(expected), found \(actual))") }
    }

    // MARK: move, mkdir

    func move(root: String, from: String, to: String, expectedRevision: String, maxHashBytes: Int, cancel: IcloudCancelToken? = nil) throws -> IcloudStat {
        let source = try resolve(root, from)
        let target = try resolve(root, to)
        if try checkRelative(from).isEmpty || checkRelative(to).isEmpty { throw IcloudBridgeFailure(code: .invalidPath, message: "Cannot move the root folder") }
        try coordinator.coordinatedMove(from: source.url, to: target.url) { sourceURL, targetURL in
            try cancel?.check()
            try verifyRevision(sourceURL, expected: expectedRevision, maxHashBytes: maxHashBytes)
            var caseOnly = false
            if let existing = try lstatInfo(targetURL) {
                // A case-only rename on a case-insensitive volume "exists" as the same inode; anything else is a collision.
                guard let sourceInfo = try lstatInfo(sourceURL), sourceInfo.inode == existing.inode, sourceInfo.device == existing.device else {
                    throw IcloudBridgeFailure.precondition("\(to) already exists")
                }
                caseOnly = true
            } else if try lstatInfo(stubURL(for: targetURL)) != nil {
                throw IcloudBridgeFailure.precondition("\(to) already exists (not downloaded)")
            }
            try ensureParentInsideRoot(of: targetURL, rootReal: target.rootReal, display: to)
            try cancel?.check()
            if caseOnly {
                guard rename(sourceURL.path, targetURL.path) == 0 else { throw IcloudBridgeFailure.failed("Could not move \(from) (errno \(errno))") }
            } else {
                try renameExclusive(sourceURL, targetURL)
            }
        }
        guard let stat = try statAt(target.url, maxHashBytes: maxHashBytes, useCache: false, cancel: cancel) else {
            throw IcloudBridgeFailure.failed("The item disappeared right after it was moved")
        }
        return stat
    }

    func mkdir(root: String, path: String) throws {
        let rootName = try checkRoot(root)
        let parts = try checkRelative(path)
        if parts.isEmpty {
            guard Self.realPath(documents.path).path != nil else { throw IcloudBridgeFailure(code: .unavailable, message: "The iCloud Documents folder is not available") }
            let rootURL = documents.appendingPathComponent(rootName, isDirectory: true)
            if try lstatInfo(rootURL) != nil { return }
            do { try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: false) }
            catch { if try lstatInfo(rootURL) == nil { throw IcloudBridgeFailure.failed("Cannot create \(root): \(error.localizedDescription)") } }
            return
        }
        let resolved = try resolve(root, path)
        do { try FileManager.default.createDirectory(at: resolved.url, withIntermediateDirectories: true) }
        catch { throw IcloudBridgeFailure.failed("Cannot create \(path): \(error.localizedDescription)") }
        guard let real = Self.realPath(resolved.url.path).path, Self.isInside(real, resolved.rootReal) else {
            throw IcloudBridgeFailure(code: .invalidPath, message: "\(path) resolves outside the iCloud folder")
        }
    }

    // MARK: downloads

    func startDownload(root: String, paths: [String], cancel: IcloudCancelToken? = nil) throws {
        for path in paths {
            try cancel?.check()
            let resolved = try resolve(root, path)
            // A failed request just leaves the item not-downloaded, which callers report as an incomplete scan.
            try? ubiquity.startDownloading(at: resolved.url)
        }
    }

    func waitForDownload(root: String, paths: [String], timeoutMs: Int, pollMs: Int, cancel: IcloudCancelToken? = nil) throws -> (ready: [String], pending: [String]) {
        let targets = try paths.map { ($0, try resolve(root, $0).url) }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while true {
            try cancel?.check()
            var ready: [String] = []
            var pending: [String] = []
            for (path, url) in targets {
                if isCurrent(url) { ready.append(path) } else { pending.append(path) }
            }
            if pending.isEmpty || Date() >= deadline { return (ready, pending) }
            // Sleep in short slices so an abort is honoured promptly.
            let wake = Date().addingTimeInterval(Double(max(pollMs, 10)) / 1000)
            while Date() < wake && Date() < deadline {
                try cancel?.check()
                Thread.sleep(forTimeInterval: 0.02)
            }
        }
    }

    private func isCurrent(_ url: URL) -> Bool {
        if (try? lstatInfo(stubURL(for: url))) != nil { return false }
        guard let info = try? lstatInfo(url) else { return false }
        return !info.isRegular || ubiquity.downloadState(of: url) == .current
    }
}

// MARK: - Shared mutable state (reference type so the engine stays a value type)

private struct StagedWrite {
    var handle: FileHandle?
    let temp: URL
    let destination: URL
    let display: String
}

private final class EngineState {
    private let lock = NSLock()
    private var hashes: [String: (key: String, sha: String)] = [:]
    private var writes: [String: StagedWrite] = [:]

    func cachedHash(for path: String, key: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let entry = hashes[path], entry.key == key else { return nil }
        return entry.sha
    }

    func storeHash(_ sha: String, for path: String, key: String) {
        lock.lock(); hashes[path] = (key, sha); lock.unlock()
    }

    func pruneHashes(under prefix: String, keeping seen: Set<String>) {
        lock.lock(); defer { lock.unlock() }
        for path in hashes.keys where path.hasPrefix(prefix + "/") && !seen.contains(path) { hashes.removeValue(forKey: path) }
    }

    func addStaged(_ write: StagedWrite) -> String {
        let id = UUID().uuidString
        lock.lock(); writes[id] = write; lock.unlock()
        return id
    }

    func staged(_ id: String) -> StagedWrite? {
        lock.lock(); defer { lock.unlock() }
        return writes[id]
    }

    func markClosed(_ id: String) {
        lock.lock(); writes[id]?.handle = nil; lock.unlock()
    }

    @discardableResult
    func removeStaged(_ id: String) -> StagedWrite? {
        lock.lock(); defer { lock.unlock() }
        return writes.removeValue(forKey: id)
    }

    func stagedIds() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return Array(writes.keys)
    }
}

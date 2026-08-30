import CryptoKit
import Foundation

enum CanonicalVaultPath {
    enum PathError: Error { case outsideRoot }

    static func relative(_ child: URL, within root: URL) throws -> String {
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        let canonicalChild = child.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        guard canonicalChild.count > canonicalRoot.count,
              Array(canonicalChild.prefix(canonicalRoot.count)) == canonicalRoot else {
            throw PathError.outsideRoot
        }
        let components = canonicalChild.dropFirst(canonicalRoot.count)
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw PathError.outsideRoot
        }
        return components.joined(separator: "/")
    }
}

final class LegacyManagedVaultMigration {
    enum Result: Equatable { case notApplicable, completed(URL) }
    enum MigrationError: Error, Equatable {
        case unsafeLegacyShape, insufficientSpace, corruptJournal, sourceChanged, destinationChanged, recoveryRequired
    }

    struct Hooks {
        var afterJournalWrite: () throws -> Void
        var afterCopy: (URL, URL) throws -> Void
        var afterArchiveMove: () throws -> Void
        var afterCompletedMarkerWrite: () throws -> Void
        var afterItemIOBeforeJournal: (URL, URL) throws -> Void
        init(afterJournalWrite: @escaping () throws -> Void = {},
             afterCopy: @escaping (URL, URL) throws -> Void = { _, _ in },
             afterArchiveMove: @escaping () throws -> Void = {},
             afterCompletedMarkerWrite: @escaping () throws -> Void = {},
             afterItemIOBeforeJournal: @escaping (URL, URL) throws -> Void = { _, _ in }) {
            self.afterJournalWrite = afterJournalWrite
            self.afterCopy = afterCopy
            self.afterArchiveMove = afterArchiveMove
            self.afterCompletedMarkerWrite = afterCompletedMarkerWrite
            self.afterItemIOBeforeJournal = afterItemIOBeforeJournal
        }
    }

    private enum Kind: String, Codable { case directory, file, trashRecord }
    private enum State: String, Codable { case planned, copying, copied, deduplicated }
    private struct AbruptTermination: Error { let underlying: Error }
    private enum Phase: String, Codable { case planned, copying, archived, completed, recoveryRequired }
    private struct ManifestEntry: Codable, Equatable { let path: String; let kind: Kind; let hash: String; let size: Int64 }
    private struct Item: Codable, Equatable {
        let sourcePath: String; let destinationPath: String; let kind: Kind; let sourceHash: String
        var state: State; var migrationOwned: Bool
    }
    private struct Journal: Codable, Equatable {
        let version: Int; let identifier: String; let rootPath: String
        let sourceManifest: [ManifestEntry]; let sourceManifestHash: String; let archivePath: String
        var phase: Phase; var items: [Item]; var error: String?; var integrityHash: String
    }

    private let root: URL
    private let applicationSupport: URL
    private let availableCapacity: (() throws -> Int64)?
    private let hooks: Hooks
    private let fileManager: FileManager
    private let journalName = "GeodeLegacyManagedVaultMigration-v1.json"
    private let completedName = "GeodeLegacyManagedVaultMigration-v1.complete"
    private let wrapperName = "Vault"
    private let trashName = ".geode-trash"
    private let markerName = ".geode-legacy-managed-wrapper-fixture"
    private let markerBytes = Data("geode-legacy-managed-wrapper-v1".utf8)
    private let defaultWelcome = Data("# Welcome to Geode Mobile\n".utf8)

    init(root: URL, applicationSupport: URL, fileManager: FileManager = .default,
         availableCapacity: (() throws -> Int64)? = nil, hooks: Hooks = .init()) {
        self.root = root.standardizedFileURL
        self.applicationSupport = applicationSupport.standardizedFileURL
        self.fileManager = fileManager
        self.availableCapacity = availableCapacity
        self.hooks = hooks
    }

    func migrateIfNeeded() throws -> Result {
        try fileManager.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
        if fileManager.fileExists(atPath: journalURL.path) {
            var journal = try loadJournal()
            if journal.phase == .recoveryRequired { throw MigrationError.recoveryRequired }
            if journal.phase == .completed {
                // Completion-time verification is the data-integrity gate. Live
                // destinations are user-owned after commit and may be edited,
                // renamed, or deleted; the retained backup may also be moved.
                return .completed(URL(fileURLWithPath: journal.archivePath, isDirectory: true))
            }
            return try execute(&journal)
        }
        guard fileManager.fileExists(atPath: wrapper.path), try hasFingerprint() else { return .notApplicable }
        let manifest = try makeManifest(wrapper)
        let needed = manifest.reduce(Int64(64 * 1024)) { $0 + $1.size }
        guard try capacity() >= needed else { throw MigrationError.insufficientSpace }
        var journal = try plan(manifest)
        try save(&journal)
        return try execute(&journal)
    }

    private var wrapper: URL { root.appendingPathComponent(wrapperName, isDirectory: true) }
    private var journalURL: URL { applicationSupport.appendingPathComponent(journalName) }
    private var completedURL: URL { applicationSupport.appendingPathComponent(completedName) }

    private func hasFingerprint() throws -> Bool {
        let wrapperValues = try wrapper.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard wrapperValues.isDirectory == true, wrapperValues.isSymbolicLink != true else { return false }
        let trash = wrapper.appendingPathComponent(trashName, isDirectory: true)
        guard fileManager.fileExists(atPath: trash.path) else { return false }
        let trashValues = try trash.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard trashValues.isDirectory == true, trashValues.isSymbolicLink != true else { return false }
        let markerOK = (try? Data(contentsOf: wrapper.appendingPathComponent(markerName))) == markerBytes
        let welcomeOK = (try? Data(contentsOf: wrapper.appendingPathComponent("Welcome.md"))) == defaultWelcome
        guard markerOK || welcomeOK else { return false }
        _ = try makeManifest(wrapper)
        return true
    }

    private func makeManifest(_ base: URL) throws -> [ManifestEntry] {
        var enumerationError: Error?
        guard let enumerator = fileManager.enumerator(at: base, includingPropertiesForKeys: [
            .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey
        ], options: [], errorHandler: { _, error in enumerationError = error; return false }) else {
            throw MigrationError.unsafeLegacyShape
        }
        var entries: [ManifestEntry] = []
        while let url = enumerator.nextObject() as? URL {
            let path = try relative(url, to: base)
            let components = path.split(separator: "/").map(String.init)
            guard components.allSatisfy({ $0 == $0.precomposedStringWithCanonicalMapping && $0 != "." && $0 != ".." }) else {
                throw MigrationError.unsafeLegacyShape
            }
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw MigrationError.unsafeLegacyShape }
            if values.isDirectory == true {
                entries.append(.init(path: path, kind: .directory, hash: "directory", size: 0))
            } else if values.isRegularFile == true {
                let data = try Data(contentsOf: url, options: [.mappedIfSafe])
                entries.append(.init(path: path, kind: .file, hash: digest(data), size: Int64(data.count)))
            } else { throw MigrationError.unsafeLegacyShape }
        }
        if enumerationError != nil { throw MigrationError.unsafeLegacyShape }
        return entries.sorted { $0.path < $1.path }
    }

    private func plan(_ manifest: [ManifestEntry]) throws -> Journal {
        let manifestData = try sortedEncoder.encode(manifest)
        let identifier = String(digest(manifestData).prefix(12))
        var reserved = try existingNames()
        var directoryMap: [String: String] = [:]
        var items: [Item] = []
        let exactFixtureMarker = (try? Data(contentsOf: wrapper.appendingPathComponent(markerName))) == markerBytes
        let content = manifest.filter {
            (!exactFixtureMarker || $0.path != markerName) && $0.path != trashName && !$0.path.hasPrefix(trashName + "/")
        }.sorted {
            let ld = $0.path.split(separator: "/").count, rd = $1.path.split(separator: "/").count
            if ld != rd { return ld < rd }
            if $0.kind != $1.kind { return $0.kind == .directory }
            return $0.path < $1.path
        }
        for entry in content {
            let sourceParent = parent(entry.path)
            let destinationParent = directoryMap[sourceParent] ?? sourceParent
            let name = URL(fileURLWithPath: entry.path).lastPathComponent
            let resolved = try resolve(name, sourceKind: entry.kind, sourceHash: entry.hash,
                                       parent: destinationParent, reserved: &reserved)
            let destination = join(destinationParent, resolved.name)
            if entry.kind == .directory { directoryMap[entry.path] = destination }
            items.append(.init(sourcePath: entry.path, destinationPath: destination, kind: entry.kind,
                               sourceHash: entry.hash, state: resolved.dedup ? .deduplicated : .planned,
                               migrationOwned: false))
        }
        let rootTrash = root.appendingPathComponent(trashName, isDirectory: true)
        let trashState: State
        if fileManager.fileExists(atPath: rootTrash.path) {
            let values = try rootTrash.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw MigrationError.destinationChanged }
            trashState = .deduplicated
        } else {
            reserve(trashName, in: "", reserved: &reserved)
            trashState = .planned
        }
        items.append(.init(sourcePath: trashName, destinationPath: trashName, kind: .directory,
                           sourceHash: "directory", state: trashState, migrationOwned: false))
        items += try planTrash(reserved: &reserved)
        return .init(version: 1, identifier: identifier, rootPath: root.path, sourceManifest: manifest,
                     sourceManifestHash: digest(manifestData), archivePath: uniqueArchive(identifier).path,
                     phase: .planned, items: items, error: nil, integrityHash: "")
    }

    private func planTrash(reserved: inout [String: Set<String>]) throws -> [Item] {
        let trash = wrapper.appendingPathComponent(trashName, isDirectory: true)
        let records = (try? fileManager.contentsOfDirectory(at: trash, includingPropertiesForKeys: nil)) ?? []
        var result: [Item] = []
        for record in records.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let id = record.lastPathComponent
            guard UUID(uuidString: id) != nil, try validTrash(record) else { continue }
            let recordHash = digest(try sortedEncoder.encode(makeManifest(record)))
            let originalDestination = root.appendingPathComponent(trashName).appendingPathComponent(id)
            var destinationID = id
            var state: State = .planned
            if fileManager.fileExists(atPath: originalDestination.path) {
                let existingHash = digest(try sortedEncoder.encode(makeManifest(originalDestination)))
                if existingHash == recordHash { state = .deduplicated }
                else { destinationID = recoveredUUID(id + recordHash, reserved: &reserved) }
            } else { reserve(id, in: trashName, reserved: &reserved) }
            result.append(.init(sourcePath: join(trashName, id), destinationPath: join(trashName, destinationID),
                                kind: .trashRecord, sourceHash: recordHash, state: state, migrationOwned: false))
        }
        return result
    }

    private func validTrash(_ record: URL) throws -> Bool {
        let values = try record.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { return false }
        let payload = record.appendingPathComponent("payload"), metadata = record.appendingPathComponent("metadata.json")
        guard fileManager.fileExists(atPath: payload.path), fileManager.fileExists(atPath: metadata.path),
              let object = try? JSONSerialization.jsonObject(with: Data(contentsOf: metadata)) as? [String: Any],
              let path = object["originalPath"] as? String, !path.isEmpty else { return false }
        return true
    }

    private struct Resolution { let name: String; let dedup: Bool }
    private func resolve(_ name: String, sourceKind: Kind, sourceHash: String, parent: String,
                         reserved: inout [String: Set<String>]) throws -> Resolution {
        let parentURL = parent.isEmpty ? root : root.appendingPathComponent(parent, isDirectory: true)
        let exact = parentURL.appendingPathComponent(name)
        let actualNames = (try? fileManager.contentsOfDirectory(atPath: parentURL.path)) ?? []
        let normalizedSpellingCollision = actualNames.contains { $0 != name && normalized($0) == normalized(name) }
        if !normalizedSpellingCollision, actualNames.contains(name), fileManager.fileExists(atPath: exact.path) {
            let values = try exact.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw MigrationError.destinationChanged }
            if sourceKind == .directory, values.isDirectory == true {
                reserve(name, in: parent, reserved: &reserved); return .init(name: name, dedup: true)
            }
            if sourceKind == .file, values.isRegularFile == true,
               digest(try Data(contentsOf: exact, options: [.mappedIfSafe])) == sourceHash {
                reserve(name, in: parent, reserved: &reserved); return .init(name: name, dedup: true)
            }
        } else if !normalizedSpellingCollision,
                  !fileManager.fileExists(atPath: exact.path),
                  !reserved[parent, default: []].contains(normalized(name)) {
            reserve(name, in: parent, reserved: &reserved); return .init(name: name, dedup: false)
        }
        var count = 1
        while true {
            let candidate = recoveredName(name, count)
            if !reserved[parent, default: []].contains(normalized(candidate)),
               !fileManager.fileExists(atPath: parentURL.appendingPathComponent(candidate).path) {
                reserve(candidate, in: parent, reserved: &reserved); return .init(name: candidate, dedup: false)
            }
            count += 1
        }
    }

    private func execute(_ journal: inout Journal) throws -> Result {
        guard journal.version == 1, journal.rootPath == root.path else { throw MigrationError.corruptJournal }
        let archive = URL(fileURLWithPath: journal.archivePath, isDirectory: true)
        let wrapperExists = fileManager.fileExists(atPath: wrapper.path)
        let archiveExists = fileManager.fileExists(atPath: archive.path)
        if journal.phase != .archived, !wrapperExists, archiveExists {
            journal.phase = .archived
            try save(&journal, runHook: false)
        } else if journal.phase != .archived, !wrapperExists, !archiveExists {
            throw MigrationError.recoveryRequired
        }
        do {
            if journal.phase != .archived {
                guard try makeManifest(wrapper) == journal.sourceManifest else { throw MigrationError.sourceChanged }
                journal.phase = .copying; try save(&journal)
                try copyItems(&journal)
                guard try makeManifest(wrapper) == journal.sourceManifest else { throw MigrationError.sourceChanged }
                try archiveWrapper(archive)
                try hooks.afterArchiveMove()
                journal.phase = .archived; try save(&journal)
            }
            guard try makeManifest(archive) == journal.sourceManifest else {
                journal.phase = .recoveryRequired
                journal.error = "The retained legacy backup no longer matches the migration source manifest"
                try save(&journal, runHook: false)
                throw MigrationError.recoveryRequired
            }
            try verify(journal)
            let marker: [String: String] = ["version": "1", "archivePath": journal.archivePath,
                                             "sourceManifestHash": journal.sourceManifestHash]
            try JSONSerialization.data(withJSONObject: marker, options: [.sortedKeys]).write(to: completedURL, options: .atomic)
            try hooks.afterCompletedMarkerWrite()
            journal.phase = .completed; journal.error = nil; try save(&journal)
            return .completed(archive)
        } catch {
            if error is AbruptTermination { throw error }
            if journal.phase == .recoveryRequired {
                try? save(&journal, runHook: false)
            } else if fileManager.fileExists(atPath: archive.path), !fileManager.fileExists(atPath: wrapper.path) {
                journal.phase = .archived
                try? save(&journal, runHook: false)
            } else {
                try rollback(&journal)
            }
            throw error
        }
    }

    private func copyItems(_ journal: inout Journal) throws {
        for index in journal.items.indices where journal.items[index].state != .deduplicated {
            var item = journal.items[index]
            let source = wrapper.appendingPathComponent(item.sourcePath)
            let destination = root.appendingPathComponent(item.destinationPath)
            if item.state == .copying {
                if try interruptedCopyMatches(item, destination) {
                    journal.items[index].state = .copied
                    try save(&journal)
                    item = journal.items[index]
                } else if !fileManager.fileExists(atPath: destination.path) {
                    journal.items[index].state = .planned
                    journal.items[index].migrationOwned = false
                    try save(&journal)
                    item = journal.items[index]
                } else {
                    journal.phase = .recoveryRequired
                    journal.error = "A partially copied migration destination requires recovery"
                    try save(&journal, runHook: false)
                    throw MigrationError.recoveryRequired
                }
            }
            if item.state == .copied {
                if try matches(item, destination) { continue }
                if fileManager.fileExists(atPath: destination.path) { throw MigrationError.destinationChanged }
                journal.items[index].state = .planned; journal.items[index].migrationOwned = false
            }
            journal.items[index].state = .copying
            journal.items[index].migrationOwned = true
            try save(&journal)
            switch item.kind {
            case .directory: try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)
            case .file: try atomicCopy(source, destination)
            case .trashRecord: try copyDirectory(source, destination)
            }
            do { try hooks.afterItemIOBeforeJournal(source, destination) }
            catch { throw AbruptTermination(underlying: error) }
            journal.items[index].state = .copied; journal.items[index].migrationOwned = true
            try save(&journal)
            try hooks.afterCopy(source, destination)
        }
    }

    private func interruptedCopyMatches(_ item: Item, _ destination: URL) throws -> Bool {
        guard fileManager.fileExists(atPath: destination.path) else { return false }
        if item.kind == .directory {
            let values = try destination.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let children = try fileManager.contentsOfDirectory(atPath: destination.path)
            return values.isDirectory == true && values.isSymbolicLink != true && children.isEmpty
        }
        return try matches(item, destination)
    }

    private func atomicCopy(_ source: URL, _ destination: URL) throws {
        try fileManager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard !fileManager.fileExists(atPath: destination.path) else { throw MigrationError.destinationChanged }
        let data = try Data(contentsOf: source, options: [.mappedIfSafe])
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".geode-legacy-copy-\(UUID().uuidString)")
        do {
            try data.write(to: temporary, options: [.withoutOverwriting])
            try fileManager.moveItem(at: temporary, to: destination)
            guard digest(try Data(contentsOf: destination)) == digest(data) else { throw MigrationError.destinationChanged }
        } catch { try? fileManager.removeItem(at: temporary); throw error }
    }

    private func copyDirectory(_ source: URL, _ destination: URL) throws {
        guard !fileManager.fileExists(atPath: destination.path) else { throw MigrationError.destinationChanged }
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: false)
        do {
            for entry in try makeManifest(source).sorted(by: {
                let ld = $0.path.split(separator: "/").count, rd = $1.path.split(separator: "/").count
                return ld == rd ? $0.path < $1.path : ld < rd
            }) {
                let target = destination.appendingPathComponent(entry.path)
                if entry.kind == .directory { try fileManager.createDirectory(at: target, withIntermediateDirectories: true) }
                else { try atomicCopy(source.appendingPathComponent(entry.path), target) }
            }
        } catch { try? fileManager.removeItem(at: destination); throw error }
    }

    private func matches(_ item: Item, _ destination: URL) throws -> Bool {
        guard fileManager.fileExists(atPath: destination.path) else { return false }
        switch item.kind {
        case .directory: return try destination.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
        case .file: return digest(try Data(contentsOf: destination, options: [.mappedIfSafe])) == item.sourceHash
        case .trashRecord: return digest(try sortedEncoder.encode(makeManifest(destination))) == item.sourceHash
        }
    }

    private func verify(_ journal: Journal) throws {
        for item in journal.items {
            guard try matches(item, root.appendingPathComponent(item.destinationPath)) else { throw MigrationError.destinationChanged }
        }
    }

    private func rollback(_ journal: inout Journal) throws {
        var preserved = false
        for index in journal.items.indices.reversed() where journal.items[index].migrationOwned {
            let item = journal.items[index], destination = root.appendingPathComponent(item.destinationPath)
            if try matches(item, destination) {
                if item.kind != .directory || ((try? fileManager.contentsOfDirectory(atPath: destination.path)) ?? []).isEmpty {
                    try? fileManager.removeItem(at: destination)
                }
                journal.items[index].state = .planned; journal.items[index].migrationOwned = false
            } else if fileManager.fileExists(atPath: destination.path) { preserved = true }
        }
        journal.phase = preserved ? .recoveryRequired : (journal.phase == .archived ? .archived : .planned)
        if preserved { journal.error = "A migration destination changed after copy" }
        try? save(&journal, runHook: false)
    }

    private func archiveWrapper(_ archive: URL) throws {
        guard !fileManager.fileExists(atPath: archive.path) else { throw MigrationError.destinationChanged }
        let sourceVolume = try wrapper.resourceValues(forKeys: [.volumeIdentifierKey]).volumeIdentifier
        let destinationVolume = try archive.deletingLastPathComponent().resourceValues(forKeys: [.volumeIdentifierKey]).volumeIdentifier
        guard String(describing: sourceVolume) == String(describing: destinationVolume) else { throw MigrationError.unsafeLegacyShape }
        var coordinationError: NSError?, operationError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: wrapper, options: .forMoving,
            writingItemAt: archive, options: [], error: &coordinationError) { source, destination in
                do { try fileManager.moveItem(at: source, to: destination) } catch { operationError = error }
            }
        if let error = coordinationError ?? operationError { throw error }
    }

    private func save(_ journal: inout Journal, runHook: Bool = true) throws {
        journal.integrityHash = try journalIntegrityHash(journal)
        try sortedEncoder.encode(journal).write(to: journalURL, options: .atomic)
        if runHook { try hooks.afterJournalWrite() }
    }

    private func loadJournal() throws -> Journal {
        do {
            let journal = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: journalURL))
            try validateJournal(journal)
            return journal
        } catch let error as MigrationError { throw error }
        catch { throw MigrationError.corruptJournal }
    }

    private func validateJournal(_ journal: Journal) throws {
        let archive = URL(fileURLWithPath: journal.archivePath, isDirectory: true).standardizedFileURL
        let expectedArchiveParent = root.deletingLastPathComponent().standardizedFileURL
        let exactFixtureMarker = journal.sourceManifest.first { $0.path == markerName }.map {
            $0.kind == .file && $0.hash == digest(markerBytes)
        } ?? false
        let expectedContent = journal.sourceManifest.filter {
            (!exactFixtureMarker || $0.path != markerName) &&
                $0.path != trashName && !$0.path.hasPrefix(trashName + "/")
        }
        let contentItems = journal.items.filter {
            $0.sourcePath != trashName && !$0.sourcePath.hasPrefix(trashName + "/")
        }
        let trashRootItems = journal.items.filter {
            $0.sourcePath == trashName && $0.kind == .directory && $0.destinationPath == trashName
        }
        guard journal.version == 1,
              journal.rootPath == root.path,
              !journal.identifier.isEmpty,
              journal.identifier == String(journal.sourceManifestHash.prefix(12)),
              archive.deletingLastPathComponent() == expectedArchiveParent,
              archive.lastPathComponent.hasPrefix("Geode Legacy Vault Backup "),
              digest(try sortedEncoder.encode(journal.sourceManifest)) == journal.sourceManifestHash,
              try journalIntegrityHash(journal) == journal.integrityHash,
              journal.sourceManifest.allSatisfy({ safeRelativePath($0.path) }),
              Set(journal.sourceManifest.map(\.path)).count == journal.sourceManifest.count,
              journal.items.allSatisfy({ safeRelativePath($0.sourcePath) && safeRelativePath($0.destinationPath) }),
              Set(journal.items.map(\.sourcePath)).count == journal.items.count,
              Set(journal.items.map { normalized($0.destinationPath) }).count == journal.items.count,
              contentItems.count == expectedContent.count,
              expectedContent.allSatisfy({ entry in
                  contentItems.contains {
                      $0.sourcePath == entry.path && $0.kind == entry.kind && $0.sourceHash == entry.hash
                  }
              }),
              trashRootItems.count == 1,
              journal.items.allSatisfy(validStateOwnership) else {
            throw MigrationError.corruptJournal
        }
        // Once committed, live destinations are user data and the retained
        // archive is optional/mutable. Only the authenticated journal itself
        // remains an activation prerequisite on later launches.
        if journal.phase != .completed {
            try validateTrashPlan(journal, archive: archive)
        }
    }

    private func journalIntegrityHash(_ journal: Journal) throws -> String {
        var unsigned = journal
        unsigned.integrityHash = ""
        return digest(try sortedEncoder.encode(unsigned))
    }

    private func validStateOwnership(_ item: Item) -> Bool {
        switch item.state {
        case .planned, .deduplicated: return !item.migrationOwned
        case .copying, .copied: return item.migrationOwned
        }
    }

    private func validateTrashPlan(_ journal: Journal, archive: URL) throws {
        let sourceBase: URL?
        if fileManager.fileExists(atPath: wrapper.path) { sourceBase = wrapper }
        else if fileManager.fileExists(atPath: archive.path) { sourceBase = archive }
        else { sourceBase = nil }
        guard let sourceBase else { return }

        let trash = sourceBase.appendingPathComponent(trashName, isDirectory: true)
        let records = try fileManager.contentsOfDirectory(at: trash, includingPropertiesForKeys: nil)
        let validSources = try Set(records.compactMap { record -> String? in
            let id = record.lastPathComponent
            guard UUID(uuidString: id) != nil else { return nil }
            return try validTrash(record) ? join(trashName, id) : nil
        })
        let trashItems = journal.items.filter { $0.kind == .trashRecord }
        guard Set(trashItems.map(\.sourcePath)) == validSources,
              trashItems.allSatisfy({ item in
                  guard let prefix = item.sourcePath.split(separator: "/").last.map(String.init),
                        UUID(uuidString: prefix) != nil,
                        item.destinationPath.hasPrefix(trashName + "/") else { return false }
                  let record = sourceBase.appendingPathComponent(item.sourcePath, isDirectory: true)
                  return (try? digest(sortedEncoder.encode(makeManifest(record)))) == item.sourceHash
              }) else {
            throw MigrationError.corruptJournal
        }
    }

    private func safeRelativePath(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0") else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    private func existingNames() throws -> [String: Set<String>] {
        var result: [String: Set<String>] = [:]
        guard let enumerator = fileManager.enumerator(at: root, includingPropertiesForKeys: nil) else { return result }
        while let url = enumerator.nextObject() as? URL {
            let path = try relative(url, to: root)
            if path == wrapperName { enumerator.skipDescendants(); continue }
            result[parent(path), default: []].insert(normalized(url.lastPathComponent))
        }
        return result
    }

    private func uniqueArchive(_ identifier: String) -> URL {
        let parent = root.deletingLastPathComponent(), base = "Geode Legacy Vault Backup \(identifier)"
        var candidate = parent.appendingPathComponent(base, isDirectory: true), count = 2
        while fileManager.fileExists(atPath: candidate.path) {
            candidate = parent.appendingPathComponent("\(base) \(count)", isDirectory: true); count += 1
        }
        return candidate
    }

    private func capacity() throws -> Int64 {
        if let availableCapacity { return try availableCapacity() }
        let values = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        guard let capacity = values.volumeAvailableCapacityForImportantUsage else { throw MigrationError.insufficientSpace }
        return capacity
    }

    private func recoveredUUID(_ seed: String, reserved: inout [String: Set<String>]) -> String {
        var count = 0
        while true {
            var bytes = Array(SHA256.hash(data: Data("\(seed):\(count)".utf8)).prefix(16))
            bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80
            let id = UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                                  bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])).uuidString
            if !reserved[trashName, default: []].contains(normalized(id)) { reserve(id, in: trashName, reserved: &reserved); return id }
            count += 1
        }
    }

    private func recoveredName(_ name: String, _ count: Int) -> String {
        let ext = URL(fileURLWithPath: name).pathExtension
        let stem = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
        let ordinal = count == 1 ? "" : " \(count)"
        return ext.isEmpty ? "\(stem) (Recovered from legacy Vault)\(ordinal)" : "\(stem) (Recovered from legacy Vault)\(ordinal).\(ext)"
    }

    private var sortedEncoder: JSONEncoder { let value = JSONEncoder(); value.outputFormatting = [.sortedKeys]; return value }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func normalized(_ value: String) -> String { value.precomposedStringWithCanonicalMapping.lowercased() }
    private func reserve(_ name: String, in parent: String, reserved: inout [String: Set<String>]) { reserved[parent, default: []].insert(normalized(name)) }
    private func relative(_ url: URL, to base: URL) throws -> String {
        do { return try CanonicalVaultPath.relative(url, within: base) }
        catch { throw MigrationError.unsafeLegacyShape }
    }
    private func parent(_ path: String) -> String { let value = (path as NSString).deletingLastPathComponent; return value == "." ? "" : value }
    private func join(_ parent: String, _ child: String) -> String { parent.isEmpty ? child : parent + "/" + child }
}

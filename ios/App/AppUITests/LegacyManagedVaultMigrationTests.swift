import XCTest

final class LegacyManagedVaultMigrationTests: XCTestCase {
    private var sandbox: URL!
    private var root: URL!
    private var support: URL!
    private let fileManager = FileManager.default

    override func setUpWithError() throws {
        sandbox = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        root = sandbox.appendingPathComponent("Geode Vault", isDirectory: true)
        support = sandbox.appendingPathComponent("Application Support", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: support, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fileManager.removeItem(at: sandbox)
    }

    func testAliasEquivalentRootsProduceExactContainedPathsAndTargets() throws {
        let identifier = "GeodeCanonicalPath-\(UUID().uuidString)"
        let aliasRoot = URL(fileURLWithPath: "/tmp/\(identifier)/Geode Vault", isDirectory: true)
        let canonicalRoot = URL(fileURLWithPath: "/private/tmp/\(identifier)/Geode Vault", isDirectory: true)
        defer { try? fileManager.removeItem(at: canonicalRoot.deletingLastPathComponent()) }
        try write("welcome bytes", to: canonicalRoot.appendingPathComponent("Welcome.md"))
        try write("hidden bytes", to: canonicalRoot.appendingPathComponent(".geode-trash/id/payload"))

        let welcome = aliasRoot.appendingPathComponent("Welcome.md")
        let trash = aliasRoot.appendingPathComponent(".geode-trash/id/payload")
        XCTAssertEqual(try CanonicalVaultPath.relative(welcome, within: canonicalRoot), "Welcome.md")
        XCTAssertEqual(try CanonicalVaultPath.relative(trash, within: canonicalRoot), ".geode-trash/id/payload")

        let relative = try CanonicalVaultPath.relative(welcome, within: canonicalRoot)
        let coordinatedTarget = aliasRoot.appendingPathComponent(relative)
        XCTAssertTrue(fileManager.fileExists(atPath: coordinatedTarget.path))
        XCTAssertEqual(try String(contentsOf: coordinatedTarget, encoding: .utf8), "welcome bytes")

        let outside = aliasRoot.deletingLastPathComponent().appendingPathComponent("Outside.md")
        XCTAssertThrowsError(try CanonicalVaultPath.relative(outside, within: canonicalRoot))
    }

    func testOrdinaryVaultDirectoryIsUntouched() throws {
        try write("user bytes", to: root.appendingPathComponent("Vault/User.md"))

        XCTAssertEqual(try migrator().migrateIfNeeded(), .notApplicable)
        XCTAssertEqual(try text("Vault/User.md"), "user bytes")
        XCTAssertFalse(fileManager.fileExists(atPath: journal.path))
    }

    func testSiblingExternalVaultIsNeverInspectedOrMutated() throws {
        let external = sandbox.appendingPathComponent("External Provider", isDirectory: true)
        try fileManager.createDirectory(at: external.appendingPathComponent("Vault/.geode-trash"), withIntermediateDirectories: true)
        try write("# Welcome to Geode Mobile\n", to: external.appendingPathComponent("Vault/Welcome.md"))
        try write("external bytes", to: external.appendingPathComponent("Vault/External.md"))

        XCTAssertEqual(try migrator().migrateIfNeeded(), .notApplicable)
        XCTAssertEqual(
            try String(contentsOf: external.appendingPathComponent("Vault/External.md"), encoding: .utf8),
            "external bytes"
        )
        XCTAssertTrue(fileManager.fileExists(atPath: external.appendingPathComponent("Vault").path))
    }

    func testExactFixtureMigratesFilesAndArchivesWrapper() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Notes/Legacy.md"))

        let result = try migrator().migrateIfNeeded()

        guard case .completed(let backup) = result else { return XCTFail("Expected completed migration, got \(result)") }
        XCTAssertEqual(try text("Notes/Legacy.md"), "legacy")
        XCTAssertEqual(try text("Welcome.md"), "# Welcome to Geode Mobile\n")
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Vault").path))
        XCTAssertTrue(fileManager.fileExists(atPath: backup.path))
        XCTAssertTrue(fileManager.fileExists(atPath: completedMarker.path))
    }

    func testRootWinsAndDifferentBytesUseDeterministicRecoveredName() throws {
        try seedFingerprint()
        try write("root", to: root.appendingPathComponent("Note.md"))
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))

        _ = try migrator().migrateIfNeeded()

        XCTAssertEqual(try text("Note.md"), "root")
        XCTAssertEqual(try text("Note (Recovered from legacy Vault).md"), "legacy")
    }

    func testIdenticalFileCollisionDeduplicates() throws {
        try seedFingerprint()
        try write("same", to: root.appendingPathComponent("Same.md"))
        try write("same", to: root.appendingPathComponent("Vault/Same.md"))

        _ = try migrator().migrateIfNeeded()

        XCTAssertEqual(try text("Same.md"), "same")
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Same (Recovered from legacy Vault).md").path))
    }

    func testDirectoryTypeAndNormalizedCollisionsRecoverWithoutOverwrite() throws {
        try seedFingerprint()
        try write("root file", to: root.appendingPathComponent("Folder"))
        try write("nested", to: root.appendingPathComponent("Vault/Folder/Child.md"))
        try write("identical case bytes", to: root.appendingPathComponent("CASE.md"))
        try write("identical case bytes", to: root.appendingPathComponent("Vault/case.md"))
        try write("unicode root", to: root.appendingPathComponent("Caf\u{00E9}.md"))
        try write("unicode legacy", to: root.appendingPathComponent("Vault/Cafe\u{0301}.md"))

        _ = try migrator().migrateIfNeeded()

        XCTAssertEqual(try text("Folder"), "root file")
        XCTAssertEqual(try text("Folder (Recovered from legacy Vault)/Child.md"), "nested")
        XCTAssertEqual(try text("case (Recovered from legacy Vault).md"), "identical case bytes")
        XCTAssertEqual(try text("Cafe\u{0301} (Recovered from legacy Vault).md"), "unicode legacy")
    }

    func testOnlyValidTrashRecordsMergeAndUUIDCollisionGetsDeterministicUUID() throws {
        try seedFingerprint()
        let id = "11111111-1111-4111-8111-111111111111"
        try write("root payload", to: root.appendingPathComponent(".geode-trash/\(id)/payload"))
        try write("{\"originalPath\":\"Root.md\"}", to: root.appendingPathComponent(".geode-trash/\(id)/metadata.json"))
        try write("legacy payload", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/payload"))
        try write("{\"originalPath\":\"Legacy.md\"}", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/metadata.json"))
        try write("bad", to: root.appendingPathComponent("Vault/.geode-trash/not-a-uuid/payload"))

        _ = try migrator().migrateIfNeeded()

        let children = try fileManager.contentsOfDirectory(atPath: root.appendingPathComponent(".geode-trash").path)
        XCTAssertEqual(children.count, 2)
        XCTAssertTrue(children.contains(id))
        let recovered = try XCTUnwrap(children.first { $0 != id })
        XCTAssertNotNil(UUID(uuidString: recovered))
        XCTAssertEqual(try text(".geode-trash/\(recovered)/payload"), "legacy payload")
    }

    func testChangedSourceFailsClosedAndRollsBackOnlyMigrationOwnedBytes() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        let migration = migrator(hooks: .init(afterCopy: { source, _ in
            try Data("changed".utf8).write(to: source)
        }))

        XCTAssertThrowsError(try migration.migrateIfNeeded())
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Note.md").path))
        XCTAssertTrue(fileManager.fileExists(atPath: root.appendingPathComponent("Vault/Note.md").path))
    }

    func testInsufficientSpaceAndCorruptJournalFailBeforeMutation() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        XCTAssertThrowsError(try migrator(availableCapacity: { 0 }).migrateIfNeeded())
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Note.md").path))

        try write("not json", to: journal)
        XCTAssertThrowsError(try migrator().migrateIfNeeded())
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Note.md").path))
    }

    func testInterruptionResumesAndCompletedMigrationIsIdempotent() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        var interrupted = false
        XCTAssertThrowsError(try migrator(hooks: .init(afterJournalWrite: {
            if !interrupted { interrupted = true; throw InjectedFailure.interrupted }
        })).migrateIfNeeded())

        let first = try migrator().migrateIfNeeded()
        let second = try migrator().migrateIfNeeded()
        XCTAssertEqual(first, second)
        XCTAssertEqual(try text("Note.md"), "legacy")
    }

    func testRollbackPreservesDestinationEditedAfterCopy() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        let migration = migrator(hooks: .init(afterCopy: { _, destination in
            try Data("user edit".utf8).write(to: destination)
            throw InjectedFailure.interrupted
        }))

        XCTAssertThrowsError(try migration.migrateIfNeeded())
        XCTAssertEqual(try text("Note.md"), "user edit")
    }

    func testCrashAfterArchiveMoveReconcilesFromArchiveAndCompletes() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        var crashed = false
        let migration = migrator(hooks: .init(afterArchiveMove: {
            if !crashed { crashed = true; throw InjectedFailure.interrupted }
        }))

        XCTAssertThrowsError(try migration.migrateIfNeeded())
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Vault").path))
        guard case .completed(let backup) = try migrator().migrateIfNeeded() else {
            return XCTFail("Expected archive reconciliation to complete")
        }
        XCTAssertTrue(fileManager.fileExists(atPath: backup.path))
        XCTAssertEqual(try text("Note.md"), "legacy")
    }

    func testCompletedMarkerFailureKeepsCopiedRootAndResumes() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        var failed = false
        let migration = migrator(hooks: .init(afterCompletedMarkerWrite: {
            if !failed { failed = true; throw InjectedFailure.interrupted }
        }))

        XCTAssertThrowsError(try migration.migrateIfNeeded())
        XCTAssertEqual(try text("Note.md"), "legacy")
        guard case .completed = try migrator().migrateIfNeeded() else {
            return XCTFail("Expected completion marker retry to finish")
        }
        XCTAssertEqual(try text("Note.md"), "legacy")
    }

    func testSyntacticallyValidJournalWithOutsideArchiveFailsClosed() throws {
        try seedFingerprint()
        var interrupted = false
        XCTAssertThrowsError(try migrator(hooks: .init(afterJournalWrite: {
            if !interrupted { interrupted = true; throw InjectedFailure.interrupted }
        })).migrateIfNeeded())
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Any]
        )
        object["archivePath"] = sandbox.deletingLastPathComponent().appendingPathComponent("outside").path
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: journal, options: .atomic)

        XCTAssertThrowsError(try migrator().migrateIfNeeded()) { error in
            XCTAssertEqual(error as? LegacyManagedVaultMigration.MigrationError, .corruptJournal)
        }
        XCTAssertTrue(fileManager.fileExists(atPath: root.appendingPathComponent("Vault").path))
    }

    func testCompletedMigrationRemainsNoOpAfterLiveEditDeleteAndBackupRemoval() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        guard case .completed(let backup) = try migrator().migrateIfNeeded() else {
            return XCTFail("Expected completed migration")
        }
        try write("user edited", to: root.appendingPathComponent("Welcome.md"))
        try fileManager.removeItem(at: root.appendingPathComponent("Note.md"))
        try fileManager.removeItem(at: backup)

        guard case .completed = try migrator().migrateIfNeeded() else {
            return XCTFail("Completed migration must remain an idempotent no-op")
        }
        XCTAssertEqual(try text("Welcome.md"), "user edited")
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Note.md").path))
    }

    func testCompletedMigrationRemainsNoOpAfterRetainedBackupTrashIsModified() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        let id = "44444444-4444-4444-8444-444444444444"
        try write("trash", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/payload"))
        try write("{\"originalPath\":\"Trash.md\"}", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/metadata.json"))
        guard case .completed(let backup) = try migrator().migrateIfNeeded() else {
            return XCTFail("Expected completed migration")
        }
        try write("backup changed", to: backup.appendingPathComponent(".geode-trash/\(id)/payload"))
        try write("user edited", to: root.appendingPathComponent("Welcome.md"))
        try fileManager.removeItem(at: root.appendingPathComponent("Note.md"))

        guard case .completed = try migrator().migrateIfNeeded() else {
            return XCTFail("Completed migration must not revalidate the retained backup")
        }
        XCTAssertEqual(try text("Welcome.md"), "user edited")
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Note.md").path))
    }

    func testFileCopyCrashBeforeCopiedJournalResumesFromDurableIntent() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        var crashed = false
        XCTAssertThrowsError(try migrator(hooks: .init(afterItemIOBeforeJournal: { source, _ in
            if source.lastPathComponent == "Note.md", !crashed {
                crashed = true
                throw InjectedFailure.interrupted
            }
        })).migrateIfNeeded())
        XCTAssertEqual(try text("Note.md"), "legacy")

        guard case .completed = try migrator().migrateIfNeeded() else { return XCTFail("Expected resume") }
        XCTAssertEqual(try text("Note.md"), "legacy")
    }

    func testDirectoryCreationCrashBeforeCopiedJournalResumesFromEmptyIntent() throws {
        try seedFingerprint()
        try write("child", to: root.appendingPathComponent("Vault/Folder/Child.md"))
        var crashed = false
        XCTAssertThrowsError(try migrator(hooks: .init(afterItemIOBeforeJournal: { source, _ in
            if source.lastPathComponent == "Folder", !crashed {
                crashed = true
                throw InjectedFailure.interrupted
            }
        })).migrateIfNeeded())

        guard case .completed = try migrator().migrateIfNeeded() else { return XCTFail("Expected resume") }
        XCTAssertEqual(try text("Folder/Child.md"), "child")
    }

    func testTrashCopyCrashBeforeCopiedJournalResumesFromVerifiedRecord() throws {
        try seedFingerprint()
        let id = "22222222-2222-4222-8222-222222222222"
        try write("trash", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/payload"))
        try write("{\"originalPath\":\"Trash.md\"}", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/metadata.json"))
        var crashed = false
        XCTAssertThrowsError(try migrator(hooks: .init(afterItemIOBeforeJournal: { source, _ in
            if source.lastPathComponent == id, !crashed {
                crashed = true
                throw InjectedFailure.interrupted
            }
        })).migrateIfNeeded())

        guard case .completed = try migrator().migrateIfNeeded() else { return XCTFail("Expected resume") }
        XCTAssertEqual(try text(".geode-trash/\(id)/payload"), "trash")
    }

    func testTamperedArchiveFailsClosedBeforeCompletion() throws {
        try seedFingerprint()
        var crashed = false
        XCTAssertThrowsError(try migrator(hooks: .init(afterArchiveMove: {
            if !crashed { crashed = true; throw InjectedFailure.interrupted }
        })).migrateIfNeeded())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Any])
        let archivePath = try XCTUnwrap(object["archivePath"] as? String)
        try write("tampered", to: URL(fileURLWithPath: archivePath).appendingPathComponent("Welcome.md"))

        XCTAssertThrowsError(try migrator().migrateIfNeeded()) { error in
            XCTAssertEqual(error as? LegacyManagedVaultMigration.MigrationError, .recoveryRequired)
        }
        XCTAssertEqual(try text("Welcome.md"), "# Welcome to Geode Mobile\n")
    }

    func testJournalWithRemovedPlannedItemFailsClosedBeforeMutation() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        try interruptAfterInitialJournal()

        try mutateJournalItems { items in
            items.removeAll { ($0["sourcePath"] as? String) == "Note.md" }
        }

        try assertCorruptJournalPreservesLegacyWrapper()
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Note.md").path))
    }

    func testJournalWithRewrittenDestinationMappingFailsClosedBeforeMutation() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        try interruptAfterInitialJournal()

        try mutateJournalItems { items in
            let index = try XCTUnwrap(items.firstIndex { ($0["sourcePath"] as? String) == "Note.md" })
            items[index]["destinationPath"] = "Other.md"
        }

        try assertCorruptJournalPreservesLegacyWrapper()
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Other.md").path))
    }

    func testJournalWithExtraPlannedItemFailsClosedBeforeMutation() throws {
        try seedFingerprint()
        try write("legacy", to: root.appendingPathComponent("Vault/Note.md"))
        try interruptAfterInitialJournal()

        try mutateJournalItems { items in
            var extra = try XCTUnwrap(items.first { ($0["sourcePath"] as? String) == "Note.md" })
            extra["sourcePath"] = "Welcome.md"
            extra["destinationPath"] = "Injected.md"
            items.append(extra)
        }

        try assertCorruptJournalPreservesLegacyWrapper()
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent("Injected.md").path))
    }

    func testJournalWithMissingTrashMappingFailsClosedBeforeMutation() throws {
        try seedFingerprint()
        let id = "33333333-3333-4333-8333-333333333333"
        try write("trash", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/payload"))
        try write("{\"originalPath\":\"Trash.md\"}", to: root.appendingPathComponent("Vault/.geode-trash/\(id)/metadata.json"))
        try interruptAfterInitialJournal()

        try mutateJournalItems { items in
            items.removeAll { ($0["sourcePath"] as? String) == ".geode-trash/\(id)" }
        }

        try assertCorruptJournalPreservesLegacyWrapper()
        XCTAssertFalse(fileManager.fileExists(atPath: root.appendingPathComponent(".geode-trash/\(id)").path))
    }

    func testJournalWithTamperedOwnershipStateCannotDeleteExistingRootFile() throws {
        try seedFingerprint()
        try write("same", to: root.appendingPathComponent("Same.md"))
        try write("same", to: root.appendingPathComponent("Vault/Same.md"))
        try interruptAfterInitialJournal()

        try mutateJournalItems { items in
            let index = try XCTUnwrap(items.firstIndex { ($0["sourcePath"] as? String) == "Same.md" })
            items[index]["state"] = "planned"
            items[index]["migrationOwned"] = true
        }

        try assertCorruptJournalPreservesLegacyWrapper()
        XCTAssertEqual(try text("Same.md"), "same")
    }

    private enum InjectedFailure: Error { case interrupted }

    private var journal: URL { support.appendingPathComponent("GeodeLegacyManagedVaultMigration-v1.json") }
    private var completedMarker: URL { support.appendingPathComponent("GeodeLegacyManagedVaultMigration-v1.complete") }

    private func migrator(
        availableCapacity: @escaping () throws -> Int64 = { Int64.max },
        hooks: LegacyManagedVaultMigration.Hooks = .init()
    ) -> LegacyManagedVaultMigration {
        LegacyManagedVaultMigration(
            root: root,
            applicationSupport: support,
            availableCapacity: availableCapacity,
            hooks: hooks
        )
    }

    private func seedFingerprint() throws {
        try fileManager.createDirectory(at: root.appendingPathComponent("Vault/.geode-trash"), withIntermediateDirectories: true)
        try write("# Welcome to Geode Mobile\n", to: root.appendingPathComponent("Vault/Welcome.md"))
        try write("geode-legacy-managed-wrapper-v1", to: root.appendingPathComponent("Vault/.geode-legacy-managed-wrapper-fixture"))
    }

    private func interruptAfterInitialJournal() throws {
        var interrupted = false
        XCTAssertThrowsError(try migrator(hooks: .init(afterJournalWrite: {
            if !interrupted {
                interrupted = true
                throw InjectedFailure.interrupted
            }
        })).migrateIfNeeded())
    }

    private func mutateJournalItems(_ mutation: (inout [[String: Any]]) throws -> Void) throws {
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Any]
        )
        var items = try XCTUnwrap(object["items"] as? [[String: Any]])
        try mutation(&items)
        object["items"] = items
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: journal, options: .atomic)
    }

    private func assertCorruptJournalPreservesLegacyWrapper() throws {
        XCTAssertThrowsError(try migrator().migrateIfNeeded()) { error in
            XCTAssertEqual(error as? LegacyManagedVaultMigration.MigrationError, .corruptJournal)
        }
        XCTAssertTrue(fileManager.fileExists(atPath: root.appendingPathComponent("Vault").path))
        XCTAssertFalse(fileManager.fileExists(atPath: completedMarker.path))
    }

    private func write(_ value: String, to url: URL) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(value.utf8).write(to: url, options: .atomic)
    }

    private func text(_ path: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
}

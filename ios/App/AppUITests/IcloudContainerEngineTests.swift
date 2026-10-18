import XCTest

/// Drives `IcloudContainerEngine` against a temp directory with a fake coordinator and a fake ubiquity inspector. None of
/// this touches iCloud: it proves the engine's own logic (revisions, preconditions, confinement, stub normalization,
/// fail-closed conflicts, cancellation). Real iCloud propagation and NSFileCoordinator-with-iCloud behavior need the
/// two-device gate in ADR 0030 and are NOT covered here.

private final class FakeCoordinator: IcloudFileCoordinating {
    private(set) var reads: [String] = []
    private(set) var writes: [(path: String, replacing: Bool)] = []
    private(set) var moves: [(from: String, to: String)] = []
    /// Runs right before a write/move accessor: the "concurrent writer" that slips in before the engine's critical section.
    var beforeAccessor: ((URL) -> Void)?

    func coordinatedRead<T>(at url: URL, _ body: (URL) throws -> T) throws -> T {
        reads.append(url.lastPathComponent)
        return try body(url)
    }

    func coordinatedWrite<T>(at url: URL, replacing: Bool, _ body: (URL) throws -> T) throws -> T {
        writes.append((url.lastPathComponent, replacing))
        beforeAccessor?(url)
        return try body(url)
    }

    func coordinatedMove<T>(from source: URL, to destination: URL, _ body: (URL, URL) throws -> T) throws -> T {
        moves.append((source.lastPathComponent, destination.lastPathComponent))
        beforeAccessor?(source)
        return try body(source, destination)
    }
}

private final class FakeUbiquity: IcloudUbiquityInspecting {
    var notDownloaded: Set<String> = []
    var conflicted: Set<String> = []
    private(set) var downloadRequests: [String] = []
    /// Called on every `downloadState` poll; lets a test flip an item to current mid-wait.
    var onPoll: ((FakeUbiquity) -> Void)?

    func downloadState(of url: URL) -> IcloudItemAvailability {
        onPoll?(self)
        return notDownloaded.contains(url.lastPathComponent) ? .notDownloaded : .current
    }

    func hasUnresolvedConflicts(at url: URL) -> Bool { conflicted.contains(url.lastPathComponent) }

    func startDownloading(at url: URL) throws { downloadRequests.append(url.lastPathComponent) }
}

final class IcloudContainerEngineTests: XCTestCase {
    private let helloSha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    private let root = "My Vault"
    private var base: URL!
    private var documents: URL!
    private var rootURL: URL!
    private var coordinator: FakeCoordinator!
    private var ubiquity: FakeUbiquity!
    private var engine: IcloudContainerEngine!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("geode-icloud-engine-\(UUID().uuidString)", isDirectory: true)
        documents = base.appendingPathComponent("Documents", isDirectory: true)
        rootURL = documents.appendingPathComponent(root, isDirectory: true)
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        coordinator = FakeCoordinator()
        ubiquity = FakeUbiquity()
        engine = IcloudContainerEngine(documents: documents, coordinator: coordinator, ubiquity: ubiquity)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    // MARK: helpers

    private func put(_ path: String, _ text: String) throws {
        let url = rootURL.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    private func text(_ path: String) throws -> String {
        String(decoding: try Data(contentsOf: rootURL.appendingPathComponent(path)), as: UTF8.self)
    }

    private func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: rootURL.appendingPathComponent(path).path) }

    private func stat(_ path: String, maxHash: Int = 1 << 20) throws -> IcloudStat? {
        try engine.stat(root: root, path: path, maxHashBytes: maxHash)
    }

    private func assertFailure(_ code: IcloudBridgeFailure.Code, file: StaticString = #filePath, line: UInt = #line, _ body: () throws -> Void) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertEqual((error as? IcloudBridgeFailure)?.code, code, "\(error)", file: file, line: line)
        }
    }

    private func write(_ path: String, _ text: String, _ precondition: IcloudWritePrecondition) throws -> IcloudStat {
        let handle = try engine.beginWrite(root: root, path: path)
        try engine.appendChunk(handle: handle, data: Data(text.utf8))
        return try engine.commitWrite(handle: handle, precondition: precondition, maxHashBytes: 1 << 20)
    }

    private func leftoverTempFiles() -> [String] {
        let names = (try? FileManager.default.subpathsOfDirectory(atPath: rootURL.path)) ?? []
        return names.filter { ($0 as NSString).lastPathComponent.hasPrefix(IcloudContainerEngine.tempPrefix) }
    }

    // MARK: revisions and stat

    func testRevisionIsMtimeSizeSha256AndFoldersAreFolder() throws {
        try put("a.md", "hello")
        try FileManager.default.createDirectory(at: rootURL.appendingPathComponent("dir"), withIntermediateDirectories: false)
        let file = try XCTUnwrap(try stat("a.md"))
        XCTAssertEqual(file.kind, .file)
        XCTAssertEqual(file.size, 5)
        XCTAssertEqual(file.availability, .current)
        let parts = file.revision.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(Int(parts[0]), Int(file.mtimeMs))
        XCTAssertEqual(parts[1], "5")
        XCTAssertEqual(parts[2], helloSha)
        XCTAssertEqual(try stat("dir")?.revision, "folder")
        XCTAssertNil(try stat("missing.md"))
        XCTAssertNil(try engine.list(root: "No Such Root", path: ""))
    }

    func testOversizeFilesAreListedButNeverHashed() throws {
        try put("big.bin", "0123456789")
        let big = try XCTUnwrap(try stat("big.bin", maxHash: 4))
        XCTAssertTrue(big.revision.hasSuffix(":10:-"), big.revision)
    }

    // MARK: enumeration

    func testWalkIncludesDotFoldersAndHonoursSkipRules() throws {
        try put("note.md", "hello")
        try put("sub/inner.md", "x")
        try put(".geode-sync/ops/1.json", "{}")
        try put(".geode-trash/b/old.md", "old")
        try put(".DS_Store", "junk")
        try put("sub/.DS_Store", "junk")
        try put("\(IcloudContainerEngine.tempPrefix)abc", "partial")

        let everything = try engine.walk(root: root, path: "", options: IcloudWalkOptions(maxHashBytes: 1 << 20))
        let paths = Set(everything.entries.map { $0.path })
        XCTAssertTrue(paths.isSuperset(of: [".geode-sync", ".geode-sync/ops", ".geode-sync/ops/1.json", ".geode-trash/b/old.md", "note.md", "sub/inner.md"]), "\(paths)")
        XCTAssertTrue(everything.problems.isEmpty)

        let skipped = try engine.walk(root: root, path: "", options: IcloudWalkOptions(
            skipNames: [".DS_Store"], skipPrefixes: [IcloudContainerEngine.tempPrefix], skipTopLevel: [".geode-sync", ".geode-trash"], maxHashBytes: 1 << 20
        ))
        XCTAssertEqual(Set(skipped.entries.map { $0.path }), ["note.md", "sub", "sub/inner.md"])
    }

    func testStubAndEvictedFilesAreReportedUnderTheirRealName() throws {
        try put(".evicted.md.icloud", "stub")
        try put("dataless.md", "bytes")
        try put(".stale.md.icloud", "stub")
        try put("stale.md", "real")
        ubiquity.notDownloaded = ["dataless.md"]

        let listing = try XCTUnwrap(try engine.list(root: root, path: ""))
        let byName = Dictionary(uniqueKeysWithValues: listing.map { ($0.name, $0) })
        XCTAssertEqual(byName["evicted.md"]?.availability, .notDownloaded)
        XCTAssertEqual(byName["dataless.md"]?.availability, .notDownloaded)
        XCTAssertEqual(byName["stale.md"]?.availability, .current)
        XCTAssertNil(byName[".evicted.md.icloud"])
        XCTAssertEqual(listing.filter { $0.name == "stale.md" }.count, 1)

        let evicted = try XCTUnwrap(try stat("evicted.md"))
        XCTAssertEqual(evicted.availability, .notDownloaded)
        XCTAssertEqual(evicted.revision, "")
        XCTAssertEqual(try stat("dataless.md")?.revision, "")

        let walked = try engine.walk(root: root, path: "", options: IcloudWalkOptions(maxHashBytes: 1 << 20))
        let walkedByPath = Dictionary(uniqueKeysWithValues: walked.entries.map { ($0.path, $0.stat) })
        XCTAssertEqual(walkedByPath["evicted.md"]?.availability, .notDownloaded)
        XCTAssertEqual(walkedByPath["dataless.md"]?.availability, .notDownloaded)
        XCTAssertEqual(walkedByPath["stale.md"]?.availability, .current)

        assertFailure(.unavailable) { _ = try engine.read(root: root, path: "dataless.md", range: IcloudReadRange()) }
        assertFailure(.unavailable) { _ = try engine.read(root: root, path: "evicted.md", range: IcloudReadRange()) }
        XCTAssertEqual(coordinator.reads.filter { $0 == "dataless.md" }.count, 0, "an evicted file must never be coordinated-read (it would block on a download)")
    }

    func testWalkReportsSymlinksAsProblemsAndNeverFollowsThem() throws {
        try put("real.md", "hello")
        let outside = base.appendingPathComponent("outside.md")
        try Data("secret".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: rootURL.appendingPathComponent("link.md"), withDestinationURL: outside)
        let walked = try engine.walk(root: root, path: "", options: IcloudWalkOptions(maxHashBytes: 1 << 20))
        XCTAssertEqual(walked.entries.map { $0.path }, ["real.md"])
        XCTAssertEqual(walked.problems.map { $0.code }, [.symlink])
    }

    func testListRootsSkipsHiddenAndFiles() throws {
        try FileManager.default.createDirectory(at: documents.appendingPathComponent("Beta"), withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: documents.appendingPathComponent(".hidden"), withIntermediateDirectories: false)
        try Data().write(to: documents.appendingPathComponent("loose.txt"))
        XCTAssertEqual(try engine.listRoots(), ["Beta", "My Vault"])
    }

    // MARK: conflicts fail closed

    func testUnresolvedConflictsFailClosedEverywhere() throws {
        try put("c.md", "hello")
        try put("ok.md", "hello")
        let revision = try XCTUnwrap(try stat("ok.md")).revision
        ubiquity.conflicted = ["c.md"]

        assertFailure(.preconditionFailed) { _ = try stat("c.md") }
        assertFailure(.preconditionFailed) { _ = try engine.read(root: root, path: "c.md", range: IcloudReadRange()) }

        let walked = try engine.walk(root: root, path: "", options: IcloudWalkOptions(maxHashBytes: 1 << 20))
        XCTAssertEqual(walked.entries.map { $0.path }, ["ok.md"], "a conflicted file is withheld, not reported as current")
        XCTAssertEqual(walked.problems.map { $0.code }, [.unreadable])
        XCTAssertTrue(walked.problems[0].message.contains("conflict"))

        ubiquity.conflicted = ["c.md", "ok.md"]
        assertFailure(.preconditionFailed) { _ = try write("ok.md", "new", .revision(revision)) }
        XCTAssertEqual(try text("ok.md"), "hello")
        assertFailure(.preconditionFailed) { _ = try engine.move(root: root, from: "ok.md", to: "moved.md", expectedRevision: revision, maxHashBytes: 1 << 20) }
        XCTAssertTrue(exists("ok.md"))
    }

    // MARK: reads

    func testReadReturnsBytesAndRevisionAndHonoursRangesAndLimits() throws {
        try put("a.md", "hello")
        let whole = try engine.read(root: root, path: "a.md", range: IcloudReadRange())
        XCTAssertEqual(String(decoding: whole.data, as: UTF8.self), "hello")
        XCTAssertEqual(whole.revision, try stat("a.md")?.revision)
        XCTAssertGreaterThan(coordinator.reads.count, 0)

        let slice = try engine.read(root: root, path: "a.md", range: IcloudReadRange(offset: 1, length: 3))
        XCTAssertEqual(String(decoding: slice.data, as: UTF8.self), "ell")
        XCTAssertEqual(slice.revision, "", "an unvouched ranged read carries no revision")

        let vouched = try engine.read(root: root, path: "a.md", range: IcloudReadRange(offset: 0, length: 2, expectedRevision: whole.revision))
        XCTAssertEqual(String(decoding: vouched.data, as: UTF8.self), "he")
        XCTAssertEqual(vouched.revision, whole.revision)

        assertFailure(.preconditionFailed) { _ = try engine.read(root: root, path: "a.md", range: IcloudReadRange(expectedRevision: "1:5:deadbeef")) }
        assertFailure(.tooLarge) { _ = try engine.read(root: root, path: "a.md", range: IcloudReadRange(maxBytes: 4)) }
        assertFailure(.notFound) { _ = try engine.read(root: root, path: "nope.md", range: IcloudReadRange()) }
    }

    // MARK: staged conditional writes

    func testCreateOnlyNeverReplacesAnExistingFile() throws {
        let created = try write("new.md", "hello", .absent)
        XCTAssertEqual(created.revision.split(separator: ":").last.map(String.init), helloSha)
        XCTAssertEqual(coordinator.writes.last?.path, "new.md")
        XCTAssertEqual(coordinator.writes.last?.replacing, false)
        assertFailure(.preconditionFailed) { _ = try write("new.md", "other", .absent) }
        XCTAssertEqual(try text("new.md"), "hello")
        XCTAssertEqual(leftoverTempFiles(), [], "a refused write must clean up its staged file")
    }

    func testCreateOnlyTreatsAnEvictedStubAsExisting() throws {
        try put(".gone.md.icloud", "stub")
        assertFailure(.preconditionFailed) { _ = try write("gone.md", "x", .absent) }
        XCTAssertFalse(exists("gone.md"))
    }

    func testRevisionWriteReplacesOnlyWhenBytesStillMatch() throws {
        try put("a.md", "hello")
        let revision = try XCTUnwrap(try stat("a.md")).revision
        let written = try write("a.md", "second", .revision(revision))
        XCTAssertEqual(try text("a.md"), "second")
        XCTAssertEqual(written.size, 6)
        XCTAssertEqual(coordinator.writes.last?.replacing, true)

        // A stale revision is refused and leaves the file alone.
        assertFailure(.preconditionFailed) { _ = try write("a.md", "third", .revision(revision)) }
        XCTAssertEqual(try text("a.md"), "second")
        XCTAssertEqual(leftoverTempFiles(), [])
    }

    func testConcurrentWriterInsideTheCoordinationWindowIsDetected() throws {
        try put("a.md", "hello")
        let revision = try XCTUnwrap(try stat("a.md")).revision
        let target = rootURL.appendingPathComponent("a.md")
        // Another (coordinated) writer lands between the engine's stat and its replace.
        coordinator.beforeAccessor = { _ in try? Data("interloper".utf8).write(to: target) }
        assertFailure(.preconditionFailed) { _ = try write("a.md", "mine", .revision(revision)) }
        XCTAssertEqual(try text("a.md"), "interloper", "the other writer's bytes survive")
        XCTAssertEqual(leftoverTempFiles(), [])
    }

    func testRevisionWriteOfAMissingFileFails() throws {
        assertFailure(.preconditionFailed) { _ = try write("ghost.md", "x", .revision("1:1:abc")) }
        XCTAssertFalse(exists("ghost.md"))
    }

    func testUnconditionalWriteCreatesParentsAndReplaces() throws {
        _ = try write(".geode-sync/ops/1.json", "{}", .any)
        XCTAssertEqual(try text(".geode-sync/ops/1.json"), "{}")
        _ = try write(".geode-sync/ops/1.json", "{\"v\":2}", .any)
        XCTAssertEqual(try text(".geode-sync/ops/1.json"), "{\"v\":2}")
        XCTAssertEqual(leftoverTempFiles(), [])
    }

    func testUnconditionalWriteNeverReplacesAFolderWithAFile() throws {
        try put("data/keep.md", "keep")
        XCTAssertThrowsError(try write("data", "oops", .any))
        XCTAssertEqual(try text("data/keep.md"), "keep", "a folder with content must survive a file publish")
        XCTAssertEqual(leftoverTempFiles(), [])
    }

    func testRevisionWriteNeverReplacesAFolderWithAFile() throws {
        try put("data/keep.md", "keep")
        XCTAssertThrowsError(try write("data", "oops", .revision(IcloudContainerEngine.folderRevision)))
        XCTAssertEqual(try text("data/keep.md"), "keep")
        XCTAssertEqual(leftoverTempFiles(), [])
    }

    func testChunkedAppendAssemblesInOrderAndDiscardRemovesTheStagedFile() throws {
        let handle = try engine.beginWrite(root: root, path: "chunked.md")
        try engine.appendChunk(handle: handle, data: Data("hel".utf8))
        try engine.appendChunk(handle: handle, data: Data("lo".utf8))
        XCTAssertEqual(leftoverTempFiles().count, 1)
        let stat = try engine.commitWrite(handle: handle, precondition: .absent, maxHashBytes: 1 << 20)
        XCTAssertTrue(stat.revision.hasSuffix(helloSha))

        let abandoned = try engine.beginWrite(root: root, path: "abandoned.md")
        try engine.appendChunk(handle: abandoned, data: Data("x".utf8))
        engine.discardWrite(handle: abandoned)
        XCTAssertEqual(leftoverTempFiles(), [])
        assertFailure(.failed) { try engine.appendChunk(handle: abandoned, data: Data("y".utf8)) }
        assertFailure(.failed) { _ = try engine.commitWrite(handle: abandoned, precondition: .any, maxHashBytes: 1 << 20) }
    }

    func testDiscardAllWritesDropsEveryStagedFile() throws {
        _ = try engine.beginWrite(root: root, path: "one.md")
        _ = try engine.beginWrite(root: root, path: "two.md")
        XCTAssertEqual(leftoverTempFiles().count, 2)
        engine.discardAllWrites()
        XCTAssertEqual(leftoverTempFiles(), [])
    }

    // MARK: move

    func testMoveIntoTrashCreatesParentsAndChecksTheRevision() throws {
        try put("a.md", "hello")
        let revision = try XCTUnwrap(try stat("a.md")).revision
        assertFailure(.preconditionFailed) {
            _ = try engine.move(root: root, from: "a.md", to: ".geode-trash/b1/a.md", expectedRevision: "1:5:wrong", maxHashBytes: 1 << 20)
        }
        XCTAssertTrue(exists("a.md"))

        let moved = try engine.move(root: root, from: "a.md", to: ".geode-trash/b1/a.md", expectedRevision: revision, maxHashBytes: 1 << 20)
        XCTAssertEqual(moved.size, 5)
        XCTAssertFalse(exists("a.md"))
        XCTAssertEqual(try text(".geode-trash/b1/a.md"), "hello")
        XCTAssertEqual(coordinator.moves.last?.from, "a.md")
        XCTAssertEqual(coordinator.moves.last?.to, "a.md")
    }

    func testMoveNeverOverwritesAnExistingTarget() throws {
        try put("a.md", "hello")
        try put("b.md", "other")
        let revision = try XCTUnwrap(try stat("a.md")).revision
        assertFailure(.preconditionFailed) { _ = try engine.move(root: root, from: "a.md", to: "b.md", expectedRevision: revision, maxHashBytes: 1 << 20) }
        XCTAssertEqual(try text("a.md"), "hello")
        XCTAssertEqual(try text("b.md"), "other")
    }

    func testMoveOfAFolderUsesTheFolderRevision() throws {
        try put("d/inner.md", "x")
        _ = try engine.move(root: root, from: "d", to: "renamed", expectedRevision: "folder", maxHashBytes: 1 << 20)
        XCTAssertTrue(exists("renamed/inner.md"))
        XCTAssertFalse(exists("d"))
    }

    // MARK: mkdir

    func testMkdirCreatesRootAndNestedFoldersIdempotently() throws {
        try engine.mkdir(root: "Fresh", path: "")
        try engine.mkdir(root: "Fresh", path: "")
        try engine.mkdir(root: "Fresh", path: "a/b/c")
        XCTAssertTrue(FileManager.default.fileExists(atPath: documents.appendingPathComponent("Fresh/a/b/c").path))
        assertFailure(.invalidPath) { try engine.mkdir(root: ".dot", path: "") }
    }

    // MARK: confinement

    func testPathsThatEscapeTheRootAreRejected() throws {
        try put("a.md", "hello")
        for bad in ["../x.md", "a/../../x.md", "/abs.md", "a//b.md", "./a.md", "a\\b.md", "nul\0.md"] {
            assertFailure(.invalidPath) { _ = try engine.stat(root: root, path: bad, maxHashBytes: 1) }
        }
        for badRoot in ["", ".", "..", "a/b", ".hidden"] {
            assertFailure(.invalidPath) { _ = try engine.stat(root: badRoot, path: "a.md", maxHashBytes: 1) }
        }
        assertFailure(.invalidPath) { _ = try engine.beginWrite(root: root, path: "") }
    }

    func testSymlinkedFolderCannotLeadOutsideTheRoot() throws {
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secret.md"))
        try FileManager.default.createSymbolicLink(at: rootURL.appendingPathComponent("escape"), withDestinationURL: outside)
        assertFailure(.invalidPath) { _ = try engine.read(root: root, path: "escape/secret.md", range: IcloudReadRange()) }
        assertFailure(.invalidPath) { _ = try engine.beginWrite(root: root, path: "escape/new.md") }
        assertFailure(.invalidPath) { try engine.mkdir(root: root, path: "escape/deeper") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("new.md").path))
    }

    func testRootThatIsASymlinkOutOfDocumentsIsRejected() throws {
        let outside = base.appendingPathComponent("elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: documents.appendingPathComponent("Linked"), withDestinationURL: outside)
        assertFailure(.invalidPath) { _ = try engine.stat(root: "Linked", path: "", maxHashBytes: 1) }
    }

    // MARK: cancellation and downloads

    func testCancelledTokenAbortsWalkAndRead() throws {
        try put("a.md", "hello")
        let token = IcloudCancelToken()
        token.cancel()
        assertFailure(.aborted) { _ = try engine.walk(root: root, path: "", options: IcloudWalkOptions(maxHashBytes: 1), cancel: token) }
        assertFailure(.aborted) { _ = try engine.read(root: root, path: "a.md", range: IcloudReadRange(), cancel: token) }
    }

    func testStartDownloadAsksUbiquityForEveryPathAndSwallowsNothingElse() throws {
        try put("a.md", "x")
        try put("b.md", "y")
        try engine.startDownload(root: root, paths: ["a.md", "b.md"])
        XCTAssertEqual(ubiquity.downloadRequests, ["a.md", "b.md"])
        assertFailure(.invalidPath) { try engine.startDownload(root: root, paths: ["../x"]) }
    }

    func testWaitForDownloadReportsReadyAndPendingAndHonoursTheTimeout() throws {
        try put("ready.md", "x")
        try put("late.md", "y")
        try put("never.md", "z")
        ubiquity.notDownloaded = ["late.md", "never.md"]
        var polls = 0
        ubiquity.onPoll = { fake in
            polls += 1
            if polls > 6 { fake.notDownloaded.remove("late.md") }
        }
        let result = try engine.waitForDownload(root: root, paths: ["ready.md", "late.md", "never.md"], timeoutMs: 400, pollMs: 10)
        XCTAssertEqual(Set(result.ready), ["ready.md", "late.md"])
        XCTAssertEqual(result.pending, ["never.md"])

        try put(".stub.md.icloud", "s")
        let stubbed = try engine.waitForDownload(root: root, paths: ["stub.md"], timeoutMs: 30, pollMs: 10)
        XCTAssertEqual(stubbed.pending, ["stub.md"])
    }

    // MARK: container resolution

    func testResolverMapsEachUnavailableReasonAndCreatesDocuments() throws {
        var signedOut = IcloudContainerResolver()
        signedOut.hasIdentityToken = { false }
        signedOut.containerURL = { XCTFail("must not ask for the container when signed out"); return nil }
        guard case .unavailable(let reason, _) = signedOut.resolve() else { return XCTFail("expected unavailable") }
        XCTAssertEqual(reason, "not-signed-in")

        var noContainer = IcloudContainerResolver()
        noContainer.hasIdentityToken = { true }
        noContainer.containerURL = { nil }
        guard case .unavailable(let reason2, _) = noContainer.resolve() else { return XCTFail("expected unavailable") }
        XCTAssertEqual(reason2, "container-not-found")

        let container = base.appendingPathComponent("container", isDirectory: true)
        var ready = IcloudContainerResolver()
        ready.hasIdentityToken = { true }
        ready.containerURL = { container }
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        guard case .available(let url) = ready.resolve() else { return XCTFail("expected available") }
        XCTAssertEqual(url.lastPathComponent, "Documents")
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue)
    }

    func testResolverReportsPermissionDeniedWhenDocumentsCannotBeCreated() throws {
        let blocker = base.appendingPathComponent("container-file")
        try Data().write(to: blocker)
        var resolver = IcloudContainerResolver()
        resolver.hasIdentityToken = { true }
        resolver.containerURL = { blocker }
        guard case .unavailable(let reason, _) = resolver.resolve() else { return XCTFail("expected unavailable") }
        XCTAssertEqual(reason, "permission-denied")
    }

    // MARK: system seam

    func testSystemCoordinatorRunsAccessorsAndPropagatesErrors() throws {
        let file = base.appendingPathComponent("system.txt")
        try Data("hi".utf8).write(to: file)
        let coordinator = SystemIcloudFileCoordinator()
        XCTAssertEqual(try coordinator.coordinatedRead(at: file) { try String(contentsOf: $0) }, "hi")
        XCTAssertEqual(try coordinator.coordinatedWrite(at: file, replacing: true) { _ in 7 }, 7)
        struct Boom: Error {}
        XCTAssertThrowsError(try coordinator.coordinatedRead(at: file) { _ -> Int in throw Boom() }) { XCTAssertTrue($0 is Boom) }
    }
}

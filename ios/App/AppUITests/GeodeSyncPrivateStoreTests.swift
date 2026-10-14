import XCTest

/// Sync-private storage: atomic durable writes, containment, backup exclusion, and no leakage into a vault tree.
final class SyncPrivateStoreTests: XCTestCase {
    private var sandbox: URL!
    private var store: GeodeSyncPrivateStore!
    private let fileManager = FileManager.default

    override func setUpWithError() throws {
        sandbox = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: sandbox, withIntermediateDirectories: true)
        store = GeodeSyncPrivateStore(root: sandbox.appendingPathComponent("GeodeSyncPrivate", isDirectory: true), byteLimit: 1024)
    }

    override func tearDownWithError() throws {
        try? fileManager.removeItem(at: sandbox)
    }

    func testWriteReadReplaceListRemove() throws {
        XCTAssertNil(try store.read("v/b/op.json"))
        try store.write(Data("one".utf8), to: "v/b/op.json")
        try store.write(Data("blob".utf8), to: "v/b/op.blob")
        XCTAssertEqual(try store.read("v/b/op.json"), Data("one".utf8))
        try store.write(Data("two".utf8), to: "v/b/op.json")
        XCTAssertEqual(try store.read("v/b/op.json"), Data("two".utf8))
        XCTAssertEqual(try store.list("v/b").map(\.name), ["op.blob", "op.json"])
        XCTAssertEqual(try store.list("v").map(\.isFolder), [true])
        XCTAssertEqual(try store.list("missing").count, 0)
        try store.remove("v/b/op.json", recursive: false)
        try store.remove("v/b/op.json", recursive: false)
        XCTAssertNil(try store.read("v/b/op.json"))
        XCTAssertThrowsError(try store.remove("v/b", recursive: false), "a directory is never emptied by a non-recursive remove")
        try store.remove("v", recursive: true)
        XCTAssertEqual(try store.list("v").count, 0)
    }

    func testNoTemporaryFilesRemainAfterWrites() throws {
        for index in 0..<20 { try store.write(Data("x\(index)".utf8), to: "v/b/f.json") }
        XCTAssertEqual(try store.list("v/b").map(\.name), ["f.json"])
    }

    func testPathsCannotEscapeTheRoot() throws {
        for path in ["", "/abs", "../x", "a/../../x", "a//b", "a/./b", "a\\b", "a\0b"] {
            XCTAssertThrowsError(try store.write(Data(), to: path), path) { XCTAssertEqual($0 as? GeodeSyncPrivateStore.StoreError, .invalidPath) }
            XCTAssertThrowsError(try store.read(path), path)
        }
        XCTAssertFalse(fileManager.fileExists(atPath: sandbox.appendingPathComponent("x").path))
    }

    func testSizeLimitAndDirectoryTargets() throws {
        XCTAssertThrowsError(try store.write(Data(count: 1025), to: "v/big")) { XCTAssertEqual($0 as? GeodeSyncPrivateStore.StoreError, .tooLarge) }
        XCTAssertNil(try store.read("v/big"))
        try store.write(Data("x".utf8), to: "v/dir/file")
        XCTAssertThrowsError(try store.write(Data("x".utf8), to: "v/dir"))
        XCTAssertThrowsError(try store.read("v/dir"))
    }

    func testRootIsExcludedFromBackupAndOutsideAnyVault() throws {
        try store.write(Data("secret journal".utf8), to: "v/b/op.json")
        let values = try store.root.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        let vault = sandbox.appendingPathComponent("Geode Vault", isDirectory: true)
        try fileManager.createDirectory(at: vault, withIntermediateDirectories: true)
        XCTAssertFalse(store.root.path.hasPrefix(vault.path + "/"))
        XCTAssertGreaterThan(try store.availableBytes(), 0)
    }

    func testDefaultRootIsApplicationSupportNotDocuments() throws {
        let root = try GeodeSyncPrivateStore.defaultRoot().path
        XCTAssertTrue(root.contains("Application Support"))
        XCTAssertFalse(root.contains("/Documents/"))
    }
}

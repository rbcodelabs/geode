import Capacitor
import Foundation

/// Thin Capacitor glue over `IcloudContainerEngine` (ADR 0030). Every call runs on a background queue: resolving the
/// ubiquity container can block on first use, and coordinated file access must never run on the main thread. All
/// logic, including fail-closed behavior, lives in the engine; this file only decodes arguments, maps failures to
/// `call.reject(message, code)` with the bridge error codes, and routes `abort(requestId)` to a cancel token.
///
/// Wire format: bytes are base64, absent items are `{ found: false }`, errors are rejected with a bridge code
/// (`precondition-failed | not-found | unavailable | aborted | too-large | invalid-path | failed`).
@objc(GeodeIcloudContainerPlugin)
final class GeodeIcloudContainerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GeodeIcloudContainerPlugin"
    public let jsName = "GeodeIcloudContainer"
    public let pluginMethods: [CAPPluginMethod] = [
        "availability", "listRoots", "list", "walk", "stat", "read", "beginWrite", "appendChunk", "commitWrite",
        "discardWrite", "move", "mkdir", "startDownload", "waitForDownload", "abort"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private let queue = DispatchQueue(label: "com.rbcodelabs.geode.icloud-container", qos: .userInitiated, attributes: .concurrent)
    private let resolver = IcloudContainerResolver()
    private let lock = NSLock()
    private var engine: IcloudContainerEngine?
    private var tokens: [String: IcloudCancelToken] = [:]
    /// Bounded so a single Capacitor message never carries an unbounded base64 body (the provider sends 8 MiB chunks).
    private let chunkLimit = 16 * 1024 * 1024

    override func load() {
        // A fresh WebView session cannot reach staged writes started by the previous one.
        lock.lock(); let current = engine; lock.unlock()
        current?.discardAllWrites()
    }

    // MARK: Plumbing

    private func resolvedEngine() -> Result<IcloudContainerEngine, IcloudBridgeFailure> {
        lock.lock(); let cached = engine; lock.unlock()
        if let cached { return .success(cached) }
        switch resolver.resolve() {
        case .available(let documents):
            lock.lock()
            let shared = engine ?? IcloudContainerEngine(documents: documents)
            engine = shared
            lock.unlock()
            return .success(shared)
        case .unavailable(_, let message):
            return .failure(IcloudBridgeFailure(code: .unavailable, message: message))
        }
    }

    private func token(for call: CAPPluginCall) -> IcloudCancelToken {
        let token = IcloudCancelToken()
        if let id = call.getString("requestId") { lock.lock(); tokens[id] = token; lock.unlock() }
        return token
    }

    private func release(_ call: CAPPluginCall) {
        if let id = call.getString("requestId") { lock.lock(); tokens.removeValue(forKey: id); lock.unlock() }
    }

    private func reject(_ call: CAPPluginCall, _ failure: IcloudBridgeFailure) {
        call.reject(failure.message, failure.code.rawValue)
    }

    /// Runs `work` off the main thread against the resolved engine.
    private func run(_ call: CAPPluginCall, _ work: @escaping (IcloudContainerEngine, IcloudCancelToken) throws -> [String: Any]) {
        let token = token(for: call)
        queue.async {
            defer { self.release(call) }
            do {
                try token.check()
                switch self.resolvedEngine() {
                case .failure(let failure): self.reject(call, failure)
                case .success(let engine): call.resolve(try work(engine, token))
                }
            } catch let failure as IcloudBridgeFailure {
                self.reject(call, failure)
            } catch {
                self.reject(call, IcloudBridgeFailure.failed(error.localizedDescription))
            }
        }
    }

    private func string(_ call: CAPPluginCall, _ key: String) throws -> String {
        guard let value = call.getString(key) else { throw IcloudBridgeFailure(code: .invalidPath, message: "Missing argument: \(key)") }
        return value
    }

    private func integer(_ call: CAPPluginCall, _ key: String) throws -> Int {
        guard let value = call.getInt(key) else { throw IcloudBridgeFailure.failed("Missing argument: \(key)") }
        return value
    }

    // MARK: Methods

    @objc func availability(_ call: CAPPluginCall) {
        queue.async {
            switch self.resolver.resolve() {
            case .available:
                _ = self.resolvedEngine()
                call.resolve(["state": "available", "containerId": IcloudContainerEngine.containerId])
            case .unavailable(let reason, let message):
                call.resolve(["state": "unavailable", "reason": reason, "message": message])
            }
        }
    }

    @objc func listRoots(_ call: CAPPluginCall) {
        run(call) { engine, token in ["roots": try engine.listRoots(cancel: token)] }
    }

    @objc func list(_ call: CAPPluginCall) {
        run(call) { engine, token in
            guard let entries = try engine.list(root: try self.string(call, "root"), path: call.getString("path") ?? "", cancel: token) else { return ["found": false] }
            return ["found": true, "entries": entries.map { $0.wire }]
        }
    }

    @objc func walk(_ call: CAPPluginCall) {
        run(call) { engine, token in
            let options = IcloudWalkOptions(
                skipNames: Set(call.getArray("skipNames", String.self) ?? []),
                skipPrefixes: call.getArray("skipPrefixes", String.self) ?? [],
                skipTopLevel: Set(call.getArray("skipTopLevel", String.self) ?? []),
                maxHashBytes: try self.integer(call, "maxHashBytes")
            )
            let result = try engine.walk(root: try self.string(call, "root"), path: call.getString("path") ?? "", options: options, cancel: token)
            return ["entries": result.entries.map { $0.wire }, "problems": result.problems.map { $0.wire }]
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        run(call) { engine, token in
            guard let stat = try engine.stat(root: try self.string(call, "root"), path: call.getString("path") ?? "", maxHashBytes: try self.integer(call, "maxHashBytes"), cancel: token) else { return ["found": false] }
            return ["found": true, "stat": stat.wire]
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        run(call) { engine, token in
            let range = IcloudReadRange(
                offset: call.getInt("offset") ?? 0,
                length: call.getInt("length"),
                expectedRevision: call.getString("expectedRevision"),
                maxBytes: call.getInt("maxBytes")
            )
            if let length = range.length, length > self.chunkLimit { throw IcloudBridgeFailure(code: .tooLarge, message: "A single read is limited to \(self.chunkLimit) bytes") }
            let result = try engine.read(root: try self.string(call, "root"), path: try self.string(call, "path"), range: range, cancel: token)
            return ["base64": result.data.base64EncodedString(), "revision": result.revision]
        }
    }

    @objc func beginWrite(_ call: CAPPluginCall) {
        run(call) { engine, _ in ["handle": try engine.beginWrite(root: try self.string(call, "root"), path: try self.string(call, "path"))] }
    }

    @objc func appendChunk(_ call: CAPPluginCall) {
        run(call) { engine, _ in
            guard let base64 = call.getString("base64"), base64.utf8.count <= self.chunkLimit * 4 / 3 + 4, let data = Data(base64Encoded: base64) else {
                throw IcloudBridgeFailure.failed("Chunk is missing, malformed or larger than \(self.chunkLimit) bytes")
            }
            try engine.appendChunk(handle: try self.string(call, "handle"), data: data)
            return [:]
        }
    }

    @objc func commitWrite(_ call: CAPPluginCall) {
        run(call) { engine, token in
            let precondition: IcloudWritePrecondition
            switch call.getString("precondition") {
            case "absent": precondition = .absent
            case "any": precondition = .any
            case "revision":
                guard let revision = call.getString("revision") else { throw IcloudBridgeFailure.failed("A revision precondition needs a revision") }
                precondition = .revision(revision)
            default: throw IcloudBridgeFailure.failed("Unknown write precondition")
            }
            let stat = try engine.commitWrite(handle: try self.string(call, "handle"), precondition: precondition, maxHashBytes: try self.integer(call, "maxHashBytes"), cancel: token)
            return ["stat": stat.wire]
        }
    }

    @objc func discardWrite(_ call: CAPPluginCall) {
        run(call) { engine, _ in
            engine.discardWrite(handle: try self.string(call, "handle"))
            return [:]
        }
    }

    @objc func move(_ call: CAPPluginCall) {
        run(call) { engine, token in
            let stat = try engine.move(
                root: try self.string(call, "root"), from: try self.string(call, "from"), to: try self.string(call, "to"),
                expectedRevision: try self.string(call, "expectedRevision"), maxHashBytes: try self.integer(call, "maxHashBytes"), cancel: token
            )
            return ["stat": stat.wire]
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        run(call) { engine, _ in
            try engine.mkdir(root: try self.string(call, "root"), path: call.getString("path") ?? "")
            return [:]
        }
    }

    @objc func startDownload(_ call: CAPPluginCall) {
        run(call) { engine, token in
            try engine.startDownload(root: try self.string(call, "root"), paths: call.getArray("paths", String.self) ?? [], cancel: token)
            return [:]
        }
    }

    @objc func waitForDownload(_ call: CAPPluginCall) {
        run(call) { engine, token in
            let result = try engine.waitForDownload(
                root: try self.string(call, "root"), paths: call.getArray("paths", String.self) ?? [],
                timeoutMs: try self.integer(call, "timeoutMs"), pollMs: try self.integer(call, "pollMs"), cancel: token
            )
            return ["ready": result.ready, "pending": result.pending]
        }
    }

    @objc func abort(_ call: CAPPluginCall) {
        if let id = call.getString("requestId") {
            lock.lock(); let token = tokens[id]; lock.unlock()
            token?.cancel()
        }
        call.resolve()
    }
}

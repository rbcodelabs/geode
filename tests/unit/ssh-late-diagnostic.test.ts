import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const subprocess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: subprocess.spawn }));

import { HubStoreManager } from "../../src/sync-node/app-hub";
import { RpcClient, spawnTransport } from "../../src/sync-node/rpc-store";

afterEach(() => { subprocess.spawn.mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); });

function controlledChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn((_signal?: string) => {
      child.signalCode = "SIGTERM";
      child.stdout.destroy(); child.stderr.destroy();
      child.emit("close", null, "SIGTERM");
      return true;
    }),
  });
  subprocess.spawn.mockReturnValue(child);
  return child;
}

it.each([
  ["Permission denied (publickey).", "ssh-auth"],
  ["bash: geode-wiki: command not found", "ssh-no-geode-wiki"],
  ["Host key verification failed.", "ssh-host-key"],
])("reports the late child diagnostic %s after stdout EOF", async (diagnostic, code) => {
  const child = controlledChild();
  const result = new HubStoreManager().discover({ kind: "ssh", host: "synthetic-hub", path: "/synthetic-store" });
  const outcome = expect(result).rejects.toMatchObject({ code });
  const disconnected = once(child.stdin, "close");
  // Closing stdout before writing stderr is a valid child-process schedule.
  // Wait for the parent's actual connection cleanup, then let the still-live
  // producer deliver its final diagnostic; SIGTERM prevents that delivery.
  child.stdout.end();
  await disconnected;
  if (child.signalCode === null) {
    child.stderr.end(diagnostic);
    await once(child.stderr, "end");
    child.exitCode = 255;
    child.emit("close", 255, null);
  }
  await outcome;
  expect(subprocess.spawn).toHaveBeenCalledOnce();
  expect(child.kill).not.toHaveBeenCalled();
});

it("an explicit client close still terminates a child after stdout EOF retired the connection", async () => {
  const child = controlledChild();
  const client = new RpcClient(() => spawnTransport({ file: "synthetic-ssh", args: [] }));
  const result = client.call("probe", {}).catch(error => error);
  const disconnected = once(child.stdin, "close");
  child.stdout.end(); await disconnected;
  expect(child.kill).not.toHaveBeenCalled();
  await client.close();
  await client.close();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(await result).toHaveProperty("code", "unavailable");
});

it("cancellation during the stderr drain stays cancellation and terminates the child", async () => {
  const child = controlledChild(), controller = new AbortController();
  const result = new HubStoreManager().discover({ kind: "ssh", host: "synthetic-hub", path: "/synthetic-store" }, controller.signal).catch(error => error);
  const disconnected = once(child.stdin, "close");
  child.stdout.end(); await disconnected;
  controller.abort();
  expect(await result).toHaveProperty("code", "aborted");
  expect(child.kill).toHaveBeenCalledOnce();
});

it("the existing 400ms deadline remains effective while stderr has not drained", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = controlledChild();
  const result = new HubStoreManager({ connectTimeoutMs: 400 }).discover({ kind: "ssh", host: "synthetic-hub", path: "/synthetic-store" }).catch(error => error);
  const disconnected = once(child.stdin, "close");
  child.stdout.end(); await disconnected;
  await vi.advanceTimersByTimeAsync(400);
  expect(await result).toHaveProperty("code", "timeout");
  expect(child.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a stdout-closed producer that never finishes stderr without waiting for the connection deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = controlledChild();
  const result = new HubStoreManager({ connectTimeoutMs: 10_000 }).discover({ kind: "ssh", host: "synthetic-hub", path: "/synthetic-store" }).catch(error => error);
  const disconnected = once(child.stdin, "close");
  child.stdout.end(); await disconnected;
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(await result).toHaveProperty("code", "unavailable");
  expect(vi.getTimerCount()).toBe(0);
});

it("malformed protocol input still closes the child immediately", async () => {
  const child = controlledChild();
  const client = new RpcClient(() => spawnTransport({ file: "synthetic-ssh", args: [] }));
  const result = client.call("probe", {}).catch(error => error);
  const disconnected = once(child.stdin, "close");
  child.stdout.write("not JSON\n"); await disconnected;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(await result).toHaveProperty("code", "bad-frame");
  await client.close();
});

it("explicit close terminates an allocated child without awaiting its incomplete handshake", async () => {
  const child = controlledChild();
  const written = once(child.stdin, "data");
  const client = new RpcClient(() => spawnTransport({ file: "synthetic-ssh", args: [] }));
  const result = client.call("probe", {}).catch(error => error);
  await written;
  await client.close();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(await result).toHaveProperty("code", "unavailable");
});

it("a connection allocated after client close is terminated without issuing a handshake", async () => {
  let allocate!: (transport: ReturnType<typeof spawnTransport>) => void;
  const allocation = new Promise<ReturnType<typeof spawnTransport>>(resolve => { allocate = resolve; });
  const client = new RpcClient(() => allocation);
  const result = client.call("probe", {}).catch(error => error);
  const closing = client.close();
  const child = controlledChild(), written = vi.fn(); child.stdin.on("data", written);
  allocate(spawnTransport({ file: "synthetic-ssh", args: [] }));
  await closing;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(written).not.toHaveBeenCalled();
  expect(await result).toHaveProperty("code", "unavailable");
  await expect(client.call("probe", {})).rejects.toHaveProperty("code", "unavailable");
  expect(subprocess.spawn).toHaveBeenCalledOnce();
});

it("a stream error retains immediate cleanup", async () => {
  const child = controlledChild();
  const client = new RpcClient(() => spawnTransport({ file: "synthetic-ssh", args: [] }));
  const result = client.call("probe", {}).catch(error => error);
  const disconnected = once(child.stdin, "close");
  child.stdout.destroy(Error("synthetic stream error")); await disconnected;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(await result).toHaveProperty("code", "unavailable");
  await client.close();
});

it.each(["void", "resolved", "rejected"])("generic transports keep immediate %s cleanup and observe rejected drainage", async mode => {
  const input = new PassThrough(), output = new PassThrough();
  const drained = Promise.reject(Error("synthetic drainage failure"));
  const close = vi.fn(() => {
    input.destroy(); output.destroy();
    if (mode === "resolved") return Promise.resolve();
    if (mode === "rejected") return Promise.reject(Error("synthetic close failure"));
  });
  const client = new RpcClient(() => ({ input, output, close, drained }));
  const result = client.call("probe", {}).catch(error => error);
  input.end();
  expect(await result).toHaveProperty("code", "unavailable");
  await client.close();
  expect(close).toHaveBeenCalledOnce();
});

it("observed natural child close flushes an unterminated diagnostic once", async () => {
  const child = controlledChild(), diagnostic = vi.fn();
  const transport = spawnTransport({ file: "synthetic-ssh", args: [] }, diagnostic);
  const ended = once(child.stderr, "end");
  child.stderr.end("Permission denied (publickey)."); await ended;
  child.exitCode = 255; child.emit("close", 255, null);
  await transport.drained;
  child.emit("close", 255, null);
  await transport.close(); await transport.close();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith("Permission denied (publickey).");
  expect(child.kill).not.toHaveBeenCalled();
});

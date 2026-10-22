import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNotPolicyFile, foldPolicySegment, HostOwnedPolicyFileError, POLICY_FILE_ERROR } from "../../src/main/policy-guard";
import { registerVaultRemoveIpc } from "../../src/main/vault-remove-ipc";

let root: string;
let policy: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-guard-")));
  fs.mkdirSync(path.join(root, ".geode"));
  policy = path.join(root, ".geode", "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ policyVersion: 1 }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const refuses = (target: string, op: Parameters<typeof assertNotPolicyFile>[2] = "write") =>
  expect(assertNotPolicyFile(root, target, op)).rejects.toThrow(POLICY_FILE_ERROR);
const allows = (target: string, op: Parameters<typeof assertNotPolicyFile>[2] = "write") =>
  expect(assertNotPolicyFile(root, target, op)).resolves.toBeUndefined();

describe("assertNotPolicyFile", () => {
  it("throws a clear, typed error", async () => {
    const err = await assertNotPolicyFile(root, policy, "write").catch((e) => e);
    expect(err).toBeInstanceOf(HostOwnedPolicyFileError);
    expect(err.message).toMatch(/host-owned policy file/);
    expect(err.code).toBe("HOST_OWNED_POLICY_FILE");
  });

  it("refuses every operation that targets the policy file itself", async () => {
    for (const op of ["write", "mkdir", "remove", "rename-from", "rename-to"] as const) await refuses(policy, op);
  });

  it("refuses when the policy file does not exist yet (a plugin must not create one)", async () => {
    fs.rmSync(policy);
    await refuses(policy, "write");
    await refuses(policy, "rename-to");
    await refuses(policy, "mkdir");
  });

  it("refuses path-normalization tricks: .., ., case, trailing dots/spaces, :stream", async () => {
    for (const rel of [
      "notes/../.geode/policy.json",
      "./.geode/./policy.json",
      ".geode/policy.json/../policy.json",
      ".GEODE/POLICY.JSON",
      ".Geode/Policy.Json",
      ".geode/policy.json.",
      ".geode/policy.json...",
      ".geode/policy.json ",
      ".geode/policy.json::$DATA",
      ".geode/policy.json:stream",
      ".geode//policy.json",
    ]) {
      await refuses(path.resolve(root, rel));
    }
  });

  it("refuses through a symlink to the policy file, and through a symlinked .geode", async () => {
    fs.symlinkSync(policy, path.join(root, "alias.json"));
    await refuses(path.join(root, "alias.json"));
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(path.join(root, ".geode"), path.join(root, "elsewhere", "link"));
    await refuses(path.join(root, "elsewhere", "link", "policy.json"));
  });

  it("refuses through a dangling symlink that points at a not-yet-created policy file", async () => {
    fs.rmSync(policy);
    fs.symlinkSync(policy, path.join(root, "dangling.json"));
    await refuses(path.join(root, "dangling.json"));
  });

  it("refuses a hard link to the policy file (same inode)", async () => {
    fs.linkSync(policy, path.join(root, "hard.json"));
    await refuses(path.join(root, "hard.json"));
  });

  it("refuses removing or moving .geode itself while it holds a policy file", async () => {
    await refuses(path.join(root, ".geode"), "remove");
    await refuses(path.join(root, ".geode"), "rename-from");
    await refuses(path.join(root, ".GEODE"), "remove");
  });

  it("refuses moving something onto .geode (would forge a policy tree)", async () => {
    await refuses(path.join(root, ".geode"), "rename-to");
    fs.rmSync(path.join(root, ".geode"), { recursive: true });
    await refuses(path.join(root, ".geode"), "rename-to");
  });

  it("allows removing .geode when it holds no policy file", async () => {
    fs.rmSync(policy);
    await allows(path.join(root, ".geode"), "remove");
  });

  it("allows everything else, including neighbours that merely look similar", async () => {
    fs.writeFileSync(path.join(root, ".geode", "app.json"), "{}");
    for (const rel of ["note.md", ".geode/app.json", ".geode/plugins.json", ".geode/policy.json.bak", ".geode/policy2.json", "policy.json", "sub/.geode/policy.json", ".geode/plugins/x/main.js"]) {
      await allows(path.join(root, rel));
    }
    await allows(path.join(root, ".geode", "plugins"), "remove");
    await allows(path.join(root, "notes"), "rename-from");
  });

  it("removing the vault root while a policy exists is refused (it contains the policy)", async () => {
    await refuses(root, "remove");
  });
});

describe("foldPolicySegment", () => {
  it("folds case, trailing dots/spaces, streams and compatibility forms", () => {
    expect(foldPolicySegment("POLICY.JSON")).toBe("policy.json");
    expect(foldPolicySegment("policy.json. ")).toBe("policy.json");
    expect(foldPolicySegment("policy.json::$DATA")).toBe("policy.json");
    expect(foldPolicySegment("ｐolicy.json")).toBe("policy.json"); // fullwidth p
  });
});

describe("registerVaultRemoveIpc guard", () => {
  it("vault-rmdir runs the guard before removing and propagates its refusal", async () => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    registerVaultRemoveIpc({ handle: (c: string, h: any) => void handlers.set(c, h) } as any, () => root, assertNotPolicyFile);
    await expect(handlers.get("vault-rmdir")!({}, ".geode", true)).rejects.toThrow(POLICY_FILE_ERROR);
    expect(fs.existsSync(policy)).toBe(true);
    fs.mkdirSync(path.join(root, "scratch"));
    await handlers.get("vault-rmdir")!({}, "scratch", true);
    expect(fs.existsSync(path.join(root, "scratch"))).toBe(false);
  });
});

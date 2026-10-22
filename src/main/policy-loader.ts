import * as fs from "node:fs";
import * as path from "node:path";
import { validatePolicy, type ManagedPolicy } from "../renderer/policy";
import { resolveEffectivePolicy, type EffectivePolicyResult } from "../renderer/policy-layering";

/** Vault-relative location of the narrowing-only vault policy. */
export const VAULT_POLICY_REL = ".geode/policy.json";

/** A policy file is a few hundred bytes; refuse anything absurd (a hostile vault) rather than parse it. */
const MAX_POLICY_BYTES = 1024 * 1024;

/**
 * Fixed, OS-specific, machine-level path for the enterprise-managed policy
 * file — deliberately NOT the same directory as `appConfigPath()` in
 * `main.ts`. `appConfigPath()` lives under `app.getPath("userData")`, which on
 * macOS resolves to `~/Library/Application Support/Geode/` (inside the
 * user's home, user-owned). The managed-policy path below is
 * `/Library/Application Support/Geode/` at the filesystem root (no `~`) —
 * owned by an admin/root account under default OS permissions. That's the
 * entire tamper-resistance story for v1; see docs/adr/0002.
 *
 * `GEODE_POLICY_PATH` overrides the OS default so tests (and e2e specs) can
 * point at a temp file instead of requiring root writes to a real system
 * path — never touch the real system paths from tests/CI.
 */
export function policyFilePath(): string {
  if (process.env.GEODE_POLICY_PATH) return process.env.GEODE_POLICY_PATH;
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/Geode/managed-policy.json";
    case "win32":
      return path.join(process.env.ProgramData ?? "C:\\ProgramData", "Geode", "managed-policy.json");
    default:
      return "/etc/geode/managed-policy.json";
  }
}

/**
 * Read + validate one policy file fresh — no caching, no file watcher (see
 * docs/adr/0002 "Live-apply vs. read-once"). Fails open (returns `null`) on a
 * missing file, unreadable file, oversized file, or invalid JSON;
 * `validatePolicy` handles fail-open for structurally invalid-but-parseable
 * content (bad `policyVersion`/`mode`/etc).
 */
export function readPolicyFile(file: string, label: string): ManagedPolicy | null {
  let raw: unknown;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_POLICY_BYTES) {
      console.error(`${label}: policy file is ${size} bytes (limit ${MAX_POLICY_BYTES}); ignoring (fail open).`);
      return null;
    }
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`${label}: failed to read/parse policy file; ignoring (fail open).`, err);
    }
    return null;
  }
  return validatePolicy(raw);
}

/** The machine-level managed policy, or `null` (fail open). */
export function loadManagedPolicy(): ManagedPolicy | null {
  return readPolicyFile(policyFilePath(), "Managed policy");
}

/**
 * The vault's `<root>/.geode/policy.json`, or `null`. Honored only when the
 * machine policy does not say `vaultPolicy: "ignore"`; in that case the file
 * is not even read.
 */
export function loadVaultPolicy(root: string | null, machine: ManagedPolicy | null): ManagedPolicy | null {
  if (!root || machine?.vaultPolicy === "ignore") return null;
  return readPolicyFile(path.join(root, ".geode", "policy.json"), "Vault policy");
}

/** Everything the renderer needs: both layers, the merged result and where each restriction came from. */
export function loadEffectivePolicy(root: string | null): EffectivePolicyResult {
  const machine = loadManagedPolicy();
  const vault = loadVaultPolicy(root, machine);
  return { machine, vault, ...resolveEffectivePolicy(machine, vault) };
}

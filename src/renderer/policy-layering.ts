/**
 * Combines the machine policy file with a vault's `.geode/policy.json` into
 * one effective policy. Pure (no IO, no Electron/DOM), shared by the main
 * process and the renderer like `./policy`. Design: `docs/adr/0051-policy-layering.md`
 * and section 6 of `docs/design/enterprise-controls.md`.
 *
 * The one rule: the vault layer can only NARROW. Every combination below is an
 * AND / intersection / stricter-of, so a vault value that would widen is simply
 * ineffective, because the machine layer is still part of the result.
 *
 * Merge table (what `resolveEffectivePolicy` implements):
 *  - `plugins`: kept per layer; a plugin is blocked if ANY layer blocks it.
 *  - Booleans (`pluginInstall`, `sync.enabled`, target `enabled`, `hostExec`,
 *    `mobileRemoteAccess`, `github.connect`, `deliverToRemoteDaemon`,
 *    `daemons.allowSchedule/allowServe`): AND, `false` in either layer wins.
 *  - `pluginInstall.mode`: the stricter (`disabled` > `catalog-only` > `allowed`).
 *  - Exact-match lists (`harnesses`, `sync.providers`, `sync.hubAllowlist`,
 *    `remoteDaemon.hosts`, `daemons.allowedListenAddresses`): intersection;
 *    an absent list means "no restriction from this layer".
 *  - Pattern or union-style lists (`pluginInstall.sources`, `github.allowed*`):
 *    kept per layer and every layer must pass (AND). A plain intersection
 *    would be wrong here: `owners` and `repos` are an OR inside one layer, and
 *    globs/`*` suffixes cannot be intersected as strings.
 *  - Machine-ONLY (ignored with a warning in a vault file): `github.clientId`,
 *    `github.appSlug`, `github.settingsLocked`, `github.disconnect`,
 *    `vaultPolicy`. A vault must not be able to pin sign-in settings or lock a
 *    user out of a capability in someone else's vault.
 */

import {
  pluginsPolicyBlocks,
  type ManagedPolicy,
  type PluginInstallMode,
  type PluginsPolicy,
} from "./policy";

export type PolicyLayer = "machine" | "vault";

/** A GitHub owner/repo restriction from one layer: passes if it matches an owner OR a repo. */
export interface EffectiveGithubAllow {
  owners: string[];
  repos: string[];
}

export interface EffectiveTarget {
  enabled: boolean;
  /** Intersection of the layers' per-target harness lists; `undefined` = no per-target restriction. */
  harnesses?: string[];
}

export interface EffectivePolicy {
  policyVersion: 1;
  /** One entry per layer that supplied a `plugins` block, in machine, vault order. */
  plugins: Array<{ layer: PolicyLayer } & PluginsPolicy>;
  pluginInstall: {
    mode: PluginInstallMode;
    /** One list per layer that supplied `sources`; a source must satisfy every list. */
    sources?: string[][];
  };
  sync: { enabled: boolean; providers?: string[]; hubAllowlist?: string[] };
  threadExecution: {
    /** Global harness allowlist (intersection); a thread's harness must also pass its target's list. */
    harnesses?: string[];
    machine: EffectiveTarget;
    localDaemon: EffectiveTarget;
    remoteDaemon: EffectiveTarget & { hosts?: string[] };
    hostExec: { enabled: boolean; allowAlways: boolean };
    mobileRemoteAccess: boolean;
  };
  github: {
    settingsLocked: boolean;
    /** Pinned by the machine file; `undefined` = not pinned. */
    clientId?: string;
    appSlug?: string;
    /** Every entry must pass (AND), like `resolveGithubAppSettings`. */
    allow: EffectiveGithubAllow[];
    /** One list per layer; the connected login must match an entry in each. */
    allowedLogins: string[][];
    connect: boolean;
    disconnect: boolean;
    deliverToRemoteDaemon: boolean;
  };
  daemons: { allowSchedule: boolean; allowServe: boolean; allowedListenAddresses?: string[] };
  vaultPolicy: "narrow" | "ignore";
}

/**
 * Which layers produced each active restriction, keyed by dotted policy path
 * (`"sync.enabled"`, `"plugins"`, ...). A key is present only when that layer
 * actually restricts something, so an empty map means "no restrictions".
 */
export type PolicyProvenance = Record<string, PolicyLayer[]>;

/** What the `get-effective-policy` IPC returns. */
export interface EffectivePolicyResult {
  machine: ManagedPolicy | null;
  vault: ManagedPolicy | null;
  effective: EffectivePolicy;
  provenance: PolicyProvenance;
}

const MODE_RANK: Record<PluginInstallMode, number> = { allowed: 0, "catalog-only": 1, disabled: 2 };

/**
 * Drop machine-only keys from a vault document (non-mutating), warning once
 * per key. Exported for tests and for the main-process loader's callers.
 */
export function sanitizeVaultPolicy(vault: ManagedPolicy): ManagedPolicy {
  const out: ManagedPolicy = { ...vault };
  if (out.vaultPolicy !== undefined) {
    console.warn('Vault policy: "vaultPolicy" is machine-only; ignoring it.');
    delete out.vaultPolicy;
  }
  if (out.github) {
    const github = { ...out.github };
    for (const key of ["clientId", "appSlug", "settingsLocked", "disconnect"] as const) {
      if (github[key] !== undefined) {
        console.warn(`Vault policy: "github.${key}" is machine-only; ignoring it.`);
        delete github[key];
      }
    }
    out.github = github;
  }
  return out;
}

function intersect(lists: Array<string[] | undefined>): string[] | undefined {
  const present = lists.filter((l): l is string[] => Array.isArray(l));
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => a.filter((x) => b.includes(x)));
}

/**
 * Resolve the effective policy for a vault. `machine` is the validated
 * managed-policy file (or `null`); `vault` is the validated
 * `<vault>/.geode/policy.json` (or `null`). If the machine file says
 * `vaultPolicy: "ignore"` the vault document is not consulted at all.
 */
export function resolveEffectivePolicy(
  machine: ManagedPolicy | null,
  vault: ManagedPolicy | null
): { effective: EffectivePolicy; provenance: PolicyProvenance } {
  const vaultMode = machine?.vaultPolicy === "ignore" ? "ignore" : "narrow";
  const layers: Array<{ layer: PolicyLayer; p: ManagedPolicy }> = [];
  if (machine) layers.push({ layer: "machine", p: machine });
  if (vault && vaultMode !== "ignore") layers.push({ layer: "vault", p: sanitizeVaultPolicy(vault) });

  const provenance: PolicyProvenance = {};
  const note = (key: string, contributing: PolicyLayer[]) => {
    if (contributing.length > 0) provenance[key] = contributing;
  };
  const layersWith = (pick: (p: ManagedPolicy) => unknown): PolicyLayer[] =>
    layers.filter((l) => pick(l.p) !== undefined).map((l) => l.layer);
  const layersFalse = (pick: (p: ManagedPolicy) => boolean | undefined): PolicyLayer[] =>
    layers.filter((l) => pick(l.p) === false).map((l) => l.layer);

  /** AND of a boolean across layers, recording the layers that said `false`. */
  const and = (key: string, pick: (p: ManagedPolicy) => boolean | undefined): boolean => {
    const falsy = layersFalse(pick);
    note(key, falsy);
    return falsy.length === 0;
  };
  /** Intersection of an exact-match list across layers, recording supplying layers. */
  const inter = (key: string, pick: (p: ManagedPolicy) => string[] | undefined): string[] | undefined => {
    note(key, layersWith(pick));
    return intersect(layers.map((l) => pick(l.p)));
  };

  // plugins: a plugin is blocked if any layer blocks it.
  const plugins = layers.flatMap((l) => (l.p.plugins ? [{ layer: l.layer, ...l.p.plugins }] : []));
  note("plugins", plugins.map((p) => p.layer));

  // pluginInstall
  let mode: PluginInstallMode = "allowed";
  for (const l of layers) {
    const m = l.p.pluginInstall?.mode;
    if (m && MODE_RANK[m] > MODE_RANK[mode]) mode = m;
  }
  if (mode !== "allowed") {
    note("pluginInstall.mode", layers.filter((l) => l.p.pluginInstall?.mode === mode).map((l) => l.layer));
  }
  const sourceLists = layers.flatMap((l) => (l.p.pluginInstall?.sources ? [l.p.pluginInstall.sources] : []));
  note("pluginInstall.sources", layersWith((p) => p.pluginInstall?.sources));

  // sync
  const sync = {
    enabled: and("sync.enabled", (p) => p.sync?.enabled),
    providers: inter("sync.providers", (p) => p.sync?.providers),
    hubAllowlist: inter("sync.hubAllowlist", (p) => p.sync?.hubAllowlist),
  };

  // threadExecution
  const target = (name: "machine" | "localDaemon"): EffectiveTarget => ({
    enabled: and(`threadExecution.${name}.enabled`, (p) => p.threadExecution?.[name]?.enabled),
    harnesses: inter(`threadExecution.${name}.harnesses`, (p) => p.threadExecution?.[name]?.harnesses),
  });
  const threadExecution: EffectivePolicy["threadExecution"] = {
    harnesses: inter("threadExecution.harnesses", (p) => p.threadExecution?.harnesses),
    machine: target("machine"),
    localDaemon: target("localDaemon"),
    remoteDaemon: {
      enabled: and("threadExecution.remoteDaemon.enabled", (p) => p.threadExecution?.remoteDaemon?.enabled),
      harnesses: inter("threadExecution.remoteDaemon.harnesses", (p) => p.threadExecution?.remoteDaemon?.harnesses),
      hosts: inter("threadExecution.remoteDaemon.hosts", (p) => p.threadExecution?.remoteDaemon?.hosts),
    },
    hostExec: {
      enabled: and("threadExecution.hostExec.enabled", (p) => p.threadExecution?.hostExec?.enabled),
      allowAlways: and("threadExecution.hostExec.allowAlways", (p) => p.threadExecution?.hostExec?.allowAlways),
    },
    mobileRemoteAccess: and("threadExecution.mobileRemoteAccess", (p) => p.threadExecution?.mobileRemoteAccess),
  };

  // github. Pinned values and settingsLocked come from the machine layer only;
  // sanitizeVaultPolicy already removed them from the vault layer.
  const machineGithub = layers.find((l) => l.layer === "machine")?.p.github;
  const allow: EffectiveGithubAllow[] = [];
  const allowLayers: PolicyLayer[] = [];
  const loginLists: string[][] = [];
  const loginLayers: PolicyLayer[] = [];
  for (const l of layers) {
    const g = l.p.github;
    if (!g) continue;
    const owners = g.allowedOwners ?? [];
    const repos = g.allowedRepos ?? [];
    if (owners.length || repos.length) {
      allow.push({ owners, repos });
      allowLayers.push(l.layer);
    }
    if (g.allowedLogins && g.allowedLogins.length > 0) {
      loginLists.push(g.allowedLogins);
      loginLayers.push(l.layer);
    }
  }
  note("github.allow", allowLayers);
  note("github.allowedLogins", loginLayers);
  const settingsLocked = machineGithub?.settingsLocked === true;
  if (settingsLocked) note("github.settingsLocked", ["machine"]);
  if (machineGithub?.clientId) note("github.clientId", ["machine"]);
  if (machineGithub?.appSlug) note("github.appSlug", ["machine"]);
  const disconnect = machineGithub?.disconnect !== false;
  if (!disconnect) note("github.disconnect", ["machine"]);
  const github: EffectivePolicy["github"] = {
    settingsLocked,
    clientId: machineGithub?.clientId,
    appSlug: machineGithub?.appSlug,
    allow,
    allowedLogins: loginLists,
    connect: and("github.connect", (p) => p.github?.connect),
    disconnect,
    deliverToRemoteDaemon: and("github.deliverToRemoteDaemon", (p) => p.github?.deliverToRemoteDaemon),
  };

  // daemons
  const daemons = {
    allowSchedule: and("daemons.allowSchedule", (p) => p.daemons?.allowSchedule),
    allowServe: and("daemons.allowServe", (p) => p.daemons?.allowServe),
    allowedListenAddresses: inter("daemons.allowedListenAddresses", (p) => p.daemons?.allowedListenAddresses),
  };

  if (vaultMode === "ignore") note("vaultPolicy", ["machine"]);

  return {
    effective: {
      policyVersion: 1,
      plugins,
      pluginInstall: { mode, ...(sourceLists.length ? { sources: sourceLists } : {}) },
      sync,
      threadExecution,
      github,
      daemons,
      vaultPolicy: vaultMode,
    },
    provenance,
  };
}

/**
 * Whether plugin `id` is blocked under the effective policy: blocked if ANY
 * layer's `plugins` block blocks it. `null` (no policy at all) never blocks.
 */
export function isPluginBlockedEffective(effective: EffectivePolicy | null, id: string): boolean {
  if (!effective) return false;
  return effective.plugins.some((p) => pluginsPolicyBlocks(p, id));
}

/** Top-level areas a vault document restricts, for the one-time "this vault restricts" notice. */
export function vaultPolicyAreas(vault: ManagedPolicy | null): string[] {
  if (!vault) return [];
  const areas: Array<keyof ManagedPolicy> = ["plugins", "pluginInstall", "sync", "threadExecution", "github", "daemons"];
  return areas.filter((a) => vault[a] !== undefined);
}

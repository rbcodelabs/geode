#!/usr/bin/env node
/**
 * geode-update — install/update Geode from GitHub Releases, no `gh` CLI
 * required. rbcodelabs/geode is a public repository, so reading release
 * metadata and downloading release assets needs no authentication — this
 * script talks to the public GitHub REST API directly with the platform
 * `fetch`, the same approach `src/main/community.ts` and
 * `src/main/github-resolve.ts` already use for the in-app "install plugin
 * from GitHub" feature.
 *
 * Why this exists: electron-builder is configured with `identity: "-"`
 * (ad-hoc) but the published dmg ships WITHOUT a `_CodeSignature/
 * CodeResources` manifest. The embedded linker-signed ad-hoc signature
 * asserts that sealed resources must be present, so macOS reports the app as
 * "damaged" — which is NOT a quarantine problem and is not fixed by
 * `xattr -dr com.apple.quarantine` (the workaround in the README's Install
 * section). The real fix is to regenerate the signature locally, which
 * creates the missing resource manifest:
 *
 *   codesign --force --deep --sign - Geode.app
 *
 * This script automates that fix as part of every install/update, so running
 * it once means never seeing the Gatekeeper "damaged" dialog.
 *
 * Standalone by design: no imports outside Node's standard library, so it
 * runs identically whether it's part of a checkout (`node scripts/
 * geode-update.mts`) or downloaded on its own to a machine that has never
 * cloned this repo (see README.md's Install section for the one-line curl).
 *
 * Requires Node.js 23.6+ (TypeScript files run directly, no flag needed —
 * https://nodejs.org/en/blog/release/v23.6.0). On Node 22.6–23.5, add
 * `--experimental-strip-types`: `node --experimental-strip-types
 * geode-update.mts`.
 *
 * Usage:
 *   node geode-update.mts              install latest release if newer than installed
 *   node geode-update.mts --check      report versions only, change nothing
 *   node geode-update.mts --force      reinstall even if already up to date
 *   node geode-update.mts --version X  install a specific release (e.g. 0.11.1 or v0.11.1)
 *   node geode-update.mts --user       install to ~/Applications instead of /Applications
 *   node geode-update.mts --keep       keep the downloaded dmg in ~/Downloads instead of deleting it
 *
 * Env overrides (mainly for testing against a fixture server):
 *   GEODE_GITHUB_API_BASE   default "https://api.github.com" (same var the app itself honors)
 *   GEODE_VAULT_ROOTS       ":"-separated list of directories to scan for plugin data to back up,
 *                           replacing the default "home dir + its and ~/Documents's immediate subdirs" scan
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "rbcodelabs/geode";
const SYSTEM_APP_PATH = "/Applications/Geode.app";
const USER_APP_PATH = join(homedir(), "Applications", "Geode.app");
const DOWNLOAD_DIR = join(homedir(), "Downloads");
const GITHUB_API_BASE = (process.env.GEODE_GITHUB_API_BASE ?? "https://api.github.com").replace(
  /\/+$/,
  "",
);
// GitHub's REST API rejects requests with no User-Agent header, even for
// public, unauthenticated, read-only calls.
const USER_AGENT = "geode-update-script (+https://github.com/rbcodelabs/geode)";

export interface Args {
  check: boolean;
  force: boolean;
  keep: boolean;
  user: boolean;
  help: boolean;
  version?: string;
}

/** Parse CLI args. Throws on anything unrecognized — the caller decides how to report it. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, force: false, keep: false, user: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    switch (value) {
      case "--check":
        args.check = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--user":
        args.user = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--version": {
        const next = argv[i + 1];
        if (!next) throw new Error("--version requires a value (e.g. --version 0.11.1)");
        args.version = next;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${value}`);
    }
  }
  return args;
}

/** Strip a leading "v" from a tag, e.g. "v0.11.1" -> "0.11.1". */
export function norm(tag: string): string {
  return tag.replace(/^v/i, "");
}

/** Compare two version strings numerically component-by-component. <0, 0, or >0. */
export function cmpVersion(a: string, b: string): number {
  const partsA = norm(a).split(".").map(Number);
  const partsB = norm(b).split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The dmg filename electron-builder publishes for a given version + arch. */
export function assetNameFor(version: string, arch: string = process.arch): string {
  const v = norm(version);
  return arch === "arm64" ? `Geode-${v}-arm64.dmg` : `Geode-${v}.dmg`;
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}
export interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

/** Exact (case-insensitive) filename match against a release's assets. */
export function findReleaseAsset(assets: GithubReleaseAsset[], name: string): string | undefined {
  return assets.find((a) => a.name.toLowerCase() === name.toLowerCase())?.browser_download_url;
}

/** First "/Volumes/..." path in `hdiutil attach` text output. */
export function parseHdiutilMountPoint(stdout: string): string {
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("/Volumes/");
    if (idx !== -1) return line.slice(idx).trim();
  }
  throw new Error("Could not determine mount point from hdiutil output");
}

export interface ProcessRow {
  pid: number;
  comm: string;
}

/** Parse `ps -Ao pid=,comm=` output into rows. `comm` is everything after the pid, verbatim. */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid, comm: match[2] ?? "" });
  }
  return rows;
}

class GeodeUpdateError extends Error {}

function fail(message: string): never {
  throw new GeodeUpdateError(message);
}

function run(cmd: string, args: string[], quiet = false): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    throw new Error(stderr || e.message || `${cmd} failed`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preflight(): void {
  if (process.platform !== "darwin") fail("geode-update only supports macOS.");
}

function installedVersion(appPath: string): string | null {
  if (!existsSync(appPath)) return null;
  try {
    return run(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents", "Info.plist")],
      true,
    ).trim();
  } catch {
    return null;
  }
}

function canWriteApplications(): boolean {
  try {
    accessSync("/Applications", constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function githubFetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
  });
  if (res.status === 404) throw new Error(`GitHub API 404 for ${url} (repo or release not found)`);
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function fetchLatestTag(): Promise<string> {
  return githubFetchJson<GithubRelease>(`${GITHUB_API_BASE}/repos/${REPO}/releases/latest`).then(
    (release) => release.tag_name,
  );
}

function fetchReleaseByTag(tag: string): Promise<GithubRelease> {
  return githubFetchJson<GithubRelease>(`${GITHUB_API_BASE}/repos/${REPO}/releases/tags/${tag}`);
}

// ---- Quit a running Geode before overwriting its files ----------------

/**
 * Find the real "Geode.app/Contents/MacOS/Geode" main process by exact
 * end-of-line match on `ps -Ao pid=,comm=`. Deliberately NOT `pgrep -f`,
 * which has been observed to silently miss the process on at least one
 * machine — racing the update against a still-open bundle and corrupting
 * the install.
 */
function geodeMainPid(appPath: string): number | null {
  const marker = join(appPath, "Contents", "MacOS", "Geode");
  let stdout: string;
  try {
    stdout = run("ps", ["-Ao", "pid=,comm="], true);
  } catch {
    return null;
  }
  const row = parsePsOutput(stdout).find((r) => r.comm === marker);
  return row ? row.pid : null;
}

async function quitGeodeIfRunning(appPath: string): Promise<void> {
  let pid = geodeMainPid(appPath);
  if (pid === null) return;

  console.log(`  quitting running Geode (pid ${pid})...`);
  try {
    run("osascript", ["-e", 'tell application "Geode" to quit'], true);
  } catch {
    // Falls through to the poll/SIGTERM path below — osascript can fail if
    // Geode has no visible app object (e.g. still launching).
  }

  const quitDeadline = Date.now() + 7500;
  while (Date.now() < quitDeadline && geodeMainPid(appPath) !== null) {
    await delay(250);
  }

  pid = geodeMainPid(appPath);
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone between the check and the signal.
    }
    const termDeadline = Date.now() + 3000;
    while (Date.now() < termDeadline && geodeMainPid(appPath) !== null) {
      await delay(250);
    }
  }

  if (geodeMainPid(appPath) !== null) {
    fail(`Geode is still running (pid ${geodeMainPid(appPath)}) — quit it manually and re-run.`);
  }
}

// ---- Best-effort plugin-data backup before replacing the app bundle -----
//
// A past incident zeroed several claude-threads plugin settings fields
// during an update with no other copy to recover from. This is a general,
// best-effort safety net: it doesn't know or assume any particular user's
// vault names, doesn't fail the install if nothing is found, and is
// overridable via GEODE_VAULT_ROOTS for anyone whose vaults live somewhere
// this default scan won't reach.

const VAULT_MARKERS = [".geode", ".obsidian"];
const PLUGIN_RELATIVE_PATH = join("plugins", "claude-threads", "data.json");
const BACKUP_ROOT = join(homedir(), ".geode-backups");
const BACKUPS_TO_KEEP = 10;
const SUMMARY_KEYS = [
  "threads",
  "scheduledItems",
  "alwaysAllowedTools",
  "secretEnvKeys",
  "skillSources",
  "extraEnv",
] as const;

function listSubdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Directories to check for a `<marker>/plugins/claude-threads/data.json`.
 * Default scan is bounded (home dir + its immediate subdirs + ~/Documents's
 * immediate subdirs) rather than a full-disk crawl; set GEODE_VAULT_ROOTS to
 * a ":"-separated list to replace it entirely.
 */
function candidateVaultRoots(): string[] {
  const override = process.env.GEODE_VAULT_ROOTS;
  if (override) {
    return override
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  const home = homedir();
  const roots = new Set<string>([
    home,
    ...listSubdirectories(home),
    ...listSubdirectories(join(home, "Documents")),
  ]);
  return [...roots];
}

function findPluginDataFiles(): string[] {
  const found: string[] = [];
  for (const root of candidateVaultRoots()) {
    for (const marker of VAULT_MARKERS) {
      const candidate = join(root, marker, PLUGIN_RELATIVE_PATH);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

function summarizeData(raw: string): Record<string, number | string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { parseError: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const summary: Record<string, number | string> = {};
  for (const key of SUMMARY_KEYS) {
    const value = obj[key];
    if (Array.isArray(value)) summary[key] = value.length;
    else if (value && typeof value === "object") summary[key] = Object.keys(value).length;
    else if (value !== undefined) summary[key] = typeof value;
  }
  return summary;
}

function pruneOldBackups(keep: number): void {
  let names: string[];
  try {
    names = readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  const excess = names.length - keep;
  if (excess <= 0) return;
  for (const name of names.slice(0, excess)) {
    rmSync(join(BACKUP_ROOT, name), { recursive: true, force: true });
  }
}

/** Never throws — a failed backup should not block an install/update. */
function backupPluginData(): void {
  try {
    const files = findPluginDataFiles();
    if (files.length === 0) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotDir = join(BACKUP_ROOT, stamp);
    mkdirSync(snapshotDir, { recursive: true });

    files.forEach((file, index) => {
      const raw = readFileSync(file, "utf8");
      const base = `data-${index + 1}`;
      writeFileSync(join(snapshotDir, `${base}.json`), raw);
      writeFileSync(
        join(snapshotDir, `${base}.summary.json`),
        JSON.stringify({ source: file, ...summarizeData(raw) }, null, 2),
      );
    });

    console.log(`  backed up ${files.length} plugin data file(s) -> ${snapshotDir}`);
    pruneOldBackups(BACKUPS_TO_KEEP);
  } catch (err) {
    console.warn(`  warning: plugin data backup failed, continuing anyway: ${String(err)}`);
  }
}

// ---- dmg mount / app replace / re-sign -----------------------------------

function mountDmg(dmgPath: string): string {
  const stdout = run("hdiutil", ["attach", dmgPath, "-nobrowse"], true);
  return parseHdiutilMountPoint(stdout);
}

function detachQuietly(mountPoint: string): void {
  try {
    run("hdiutil", ["detach", mountPoint], true);
  } catch {
    try {
      run("hdiutil", ["detach", mountPoint, "-force"], true);
    } catch {
      console.warn(`  warning: could not detach ${mountPoint} — eject it manually if needed.`);
    }
  }
}

function findAppBundle(mountPoint: string): string {
  const entry = readdirSync(mountPoint, { withFileTypes: true }).find(
    (e) => e.isDirectory() && e.name.endsWith(".app"),
  );
  if (!entry) fail(`No .app bundle found in ${mountPoint}`);
  return join(mountPoint, entry.name);
}

function replaceApp(sourceApp: string, destApp: string): void {
  mkdirSync(dirname(destApp), { recursive: true });
  rmSync(destApp, { recursive: true, force: true });
  run("ditto", [sourceApp, destApp], true);
}

/** The actual fix for the "damaged app" Gatekeeper dialog — see file header. */
function resignApp(appPath: string): void {
  run("xattr", ["-cr", appPath], true);
  run("codesign", ["--force", "--deep", "--sign", "-", appPath], true);
  run("codesign", ["--verify", "--strict", appPath], true);
}

function printUsage(): void {
  console.log(`geode-update — install/update Geode from GitHub Releases (${REPO})

Usage:
  node geode-update.mts              install latest release if newer than installed
  node geode-update.mts --check      report versions only, change nothing
  node geode-update.mts --force      reinstall even if already up to date
  node geode-update.mts --version X  install a specific release (e.g. 0.11.1 or v0.11.1)
  node geode-update.mts --user       install to ~/Applications instead of /Applications
  node geode-update.mts --keep       keep the downloaded dmg in ~/Downloads instead of deleting it

No GitHub CLI, account, or authentication required — ${REPO} is a public repository.
Also re-signs the app locally after install, which fixes the "Geode is damaged
and can't be opened" Gatekeeper dialog (see the top of this file for why).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  preflight();

  let appPath: string;
  if (args.user) {
    appPath = USER_APP_PATH;
  } else if (canWriteApplications()) {
    appPath = SYSTEM_APP_PATH;
  } else {
    appPath = USER_APP_PATH;
    console.log(`  /Applications is not writable — installing to ${USER_APP_PATH} instead.`);
  }

  const installed = installedVersion(appPath);
  const targetTag = args.version ? `v${norm(args.version)}` : await fetchLatestTag();
  const targetVersion = norm(targetTag);

  if (args.check) {
    console.log(`installed: ${installed ?? "(not installed)"}`);
    console.log(`latest:    ${targetVersion}`);
    if (installed && cmpVersion(installed, targetVersion) > 0) {
      console.log("installed version is newer than the latest release");
    } else if (installed && cmpVersion(installed, targetVersion) === 0) {
      console.log("up to date");
    } else {
      console.log("update available");
    }
    return;
  }

  if (!args.force && !args.version && installed && cmpVersion(installed, targetVersion) >= 0) {
    console.log(`✓ already up to date (${installed})`);
    return;
  }

  const asset = assetNameFor(targetVersion);
  const tmpDir = mkdtempSync(join(tmpdir(), "geode-update-"));
  const dmgPath = join(tmpDir, asset);
  let mountPoint: string | null = null;

  try {
    console.log(`  fetching release ${targetTag}...`);
    const release = await fetchReleaseByTag(targetTag);
    const downloadUrl = findReleaseAsset(release.assets, asset);
    if (!downloadUrl) fail(`Release ${targetTag} does not have an asset named "${asset}"`);

    console.log(`  downloading ${asset}...`);
    const res = await fetch(downloadUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) fail(`Failed to download ${asset} (HTTP ${res.status})`);
    writeFileSync(dmgPath, Buffer.from(await res.arrayBuffer()));

    console.log("  mounting dmg...");
    mountPoint = mountDmg(dmgPath);
    const sourceApp = findAppBundle(mountPoint);

    await quitGeodeIfRunning(appPath);
    backupPluginData();

    console.log(`  installing to ${appPath}...`);
    replaceApp(sourceApp, appPath);

    console.log('  re-signing (fixes the "damaged app" Gatekeeper dialog)...');
    resignApp(appPath);

    const finalVersion = installedVersion(appPath);
    console.log(`✓ installed Geode ${finalVersion ?? targetVersion} -> ${appPath}`);
  } finally {
    if (mountPoint) detachQuietly(mountPoint);
    if (args.keep) {
      try {
        mkdirSync(DOWNLOAD_DIR, { recursive: true });
        copyFileSync(dmgPath, join(DOWNLOAD_DIR, asset));
        console.log(`  kept dmg at ${join(DOWNLOAD_DIR, asset)}`);
      } catch (err) {
        console.warn(`  warning: could not keep dmg in Downloads: ${String(err)}`);
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ ${message}`);
    process.exit(1);
  });
}

/**
 * Launch a first-run Geode: empty app data and an empty Documents folder, so
 * nothing from your real install or from an earlier dev run leaks in.
 *
 *   npm run fresh            # build is NOT run; run `npm run build` first
 *   npm run fresh -- --keep  # keep the temp dirs after exit (to inspect them)
 *
 * Isolation is two env/flags, because Electron's `--user-data-dir` does not
 * cover Documents (where the Starter Vault is created):
 *   --user-data-dir=<tmp>       app config, last-vault pointer, caches
 *   GEODE_DOCUMENTS_DIR=<tmp>   where "Geode Starter Vault" is created
 *
 * The temp dirs are deliberately NOT prefixed `geode-`: the e2e reaper
 * (scripts/e2e-reap.mts) treats `geode-*` dirs as leaked test state and kills
 * their processes, which would kill this instance.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { FRESH_DOCUMENTS_PREFIX, FRESH_USER_DATA_PREFIX } from "./fresh-instance-paths.mts";

const keep = process.argv.includes("--keep");
const repoRoot = path.resolve(import.meta.dirname, "..");
const electronBin = createRequire(import.meta.url)("electron") as unknown as string;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), FRESH_USER_DATA_PREFIX));
const documents = fs.mkdtempSync(path.join(os.tmpdir(), FRESH_DOCUMENTS_PREFIX));
console.log(`user data : ${userData}\ndocuments : ${documents}`);

const child = spawn(electronBin, [repoRoot, `--user-data-dir=${userData}`], {
  stdio: "inherit",
  env: { ...process.env, GEODE_DOCUMENTS_DIR: documents },
});

let done = false;
const cleanup = () => {
  if (done) return;
  done = true;
  if (keep) {
    console.log("kept temp dirs (--keep)");
    return;
  }
  for (const dir of [userData, documents]) fs.rmSync(dir, { recursive: true, force: true });
};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});

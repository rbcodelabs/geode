/**
 * Smoke test of the Compass sync provider against a REAL deployment. Run through `npm run smoke:compass-sync`
 * (esbuild bundles this file; see scripts/run-compass-sync-smoke.mjs). Environment:
 *
 *   COMPASS_URL                  https://compass.example.com   (or a preview deployment URL)
 *   COMPASS_WORKSPACE_ID         workspace id
 *   COMPASS_TOKEN                bearer API key
 *   COMPASS_EXTRA_HEADER_NAME    optional, e.g. x-vercel-protection-bypass
 *   COMPASS_EXTRA_HEADER_VALUE   optional
 *   COMPASS_SMOKE_HARD_DELETE=1  optional: remove the probe doc with DELETE instead of moving it to "Geode Trash"
 *
 * It creates one probe note under "Geode Smoke <timestamp>/", then: scan, create, replay the create (idempotency),
 * read, update, stale update (must be a precondition failure), move, trash, and a final scan. Exit code 1 on any failed check.
 */
import { createCompassProvider, stripFrontmatter } from "../src/renderer/internal-plugins/compass-sync/provider";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See the header of scripts/compass-sync-smoke.mts.`);
    process.exit(2);
  }
  return value;
};

const hardDelete = process.env.COMPASS_SMOKE_HARD_DELETE === "1";
const extraName = process.env.COMPASS_EXTRA_HEADER_NAME;
const provider = createCompassProvider({
  connection: async () => ({
    baseUrl: env("COMPASS_URL"),
    workspaceId: env("COMPASS_WORKSPACE_ID"),
    token: env("COMPASS_TOKEN"),
    trashMode: hardDelete ? "delete" : "move",
    ...(extraName ? { extraHeader: { name: extraName, value: env("COMPASS_EXTRA_HEADER_VALUE") } } : {}),
  }),
  onDiagnostics: (_vault, message) => console.log(`  note: ${message}`),
});

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const bytes = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer as ArrayBuffer;
const text = (value: ArrayBuffer): string => new TextDecoder().decode(value);
const signal = new AbortController().signal;

try {
  await provider.preflight?.();
  check("preflight (endpoint enabled, credentials accepted)", true);
  const session = await provider.open({ vaultId: "compass-smoke" });
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `Geode Smoke ${stamp}/Probe.md`;
    const moved = `Geode Smoke ${stamp}/Probe Moved.md`;
    const operationKey = `smoke-${stamp}`;

    const first = await session.scan(undefined, signal);
    check("initial scan complete with a checkpoint", first.status === "complete" && Boolean(first.cursor), `${first.status}, mode ${first.mode}, ${first.entries.length} entries`);

    const created = await session.create({ path, data: bytes("# probe\n"), operationKey, signal });
    check("create returns a file entry with the .md path", created.kind === "file" && created.path === path, `${created.path} @ ${created.revision}`);
    const replay = await session.create({ path, data: bytes("# probe\n"), operationKey, signal });
    check("create replay with the same operationKey is idempotent", replay.id === created.id);

    const afterCreate = await session.scan(undefined, signal);
    check("scan lists the new note and its folder", afterCreate.entries.some((e) => e.id === created.id && e.path === path) && afterCreate.entries.some((e) => e.kind === "folder" && e.path === `Geode Smoke ${stamp}`));

    // The server stores the text with compass_* frontmatter added; compare the body.
    const readBack = stripFrontmatter(text(await session.read(created, signal)));
    check("read returns the uploaded body (frontmatter stripped)", readBack === "# probe\n", JSON.stringify(readBack));

    const updated = await session.update({ id: created.id, path, data: bytes("# probe v2\n"), expectedRevision: created.revision, operationKey: `${operationKey}-u`, signal });
    check("update advances the revision", updated.revision !== created.revision);
    check("updated content survives", stripFrontmatter(text(await session.read(updated, signal))) === "# probe v2\n");
    const stale = await session.update({ id: created.id, path, data: bytes("# stale\n"), expectedRevision: created.revision, operationKey: `${operationKey}-s`, signal }).then(() => "accepted", (error: Error) => error.name);
    check("stale update is a SyncPreconditionError", stale === "SyncPreconditionError", String(stale));

    const afterMove = (await session.move({ id: created.id, path: moved, expectedRevision: updated.revision, signal }))!;
    check("move returns the new path", afterMove.path === moved, afterMove.path);

    await session.trash({ id: created.id, expectedRevision: afterMove.revision, signal });
    const last = await session.scan(undefined, signal);
    check(hardDelete ? "delete removes the note from the scan" : "trash hides the note from the vault view of the scan", !last.entries.some((e) => e.id === created.id));
    console.log(hardDelete ? "Probe note deleted." : `Probe note is recoverable under "Geode Trash/" in the workspace; delete that folder in Compass when done.`);
  } finally {
    await session.close();
  }
} catch (error) {
  failures++;
  console.error(`FAIL  unexpected error: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

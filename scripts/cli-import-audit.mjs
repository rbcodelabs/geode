/**
 * The `geode-wiki` import-rule audit, as a function over esbuild's metafile `inputs`.
 *
 * It lives in its own module so that one rule set is shared by the two proofs that bundle the CLI
 * (`run-wiki-cli-proof.mjs`, `run-wiki-sync-proof.mjs`) and by `tests/unit/cli-import-audit.test.ts`,
 * which feeds it deliberately broken graphs to show it is not vacuous. A violation is reported as an
 * EDGE ("src/cli/x.ts imports src/y.ts (as ...)"), not merely as a surprising set, so the failure
 * names which module crossed which boundary.
 *
 * The rules (ADR 0024 for the first two entry points, ADR 0025 for the third):
 *   1. A module under src/cli/ may import, from src/, only: src/wiki/index.ts, src/catalog/index.ts,
 *      src/sync-node/index.ts, and its own siblings.
 *   2. Only src/cli/sync.ts may import src/sync-node/index.ts, and it may import nothing else outside
 *      src/cli/. The vault/catalog commands cannot grow a dependency on the sync engine, nor the reverse.
 *      src/cli/sync-schedule.ts (unit-file rendering for `sync schedule`) may import nothing outside src/cli/.
 *   3. Inside the sync graph: src/sync-node/ imports only src/sync-node/, src/sync-core/ and src/shared/;
 *      src/sync-core/ imports only src/sync-core/ and src/shared/. (Bundle-level restatement of
 *      tests/unit/sync-node-boundary.test.ts and sync-core-boundary.test.ts.)
 *   4. Nothing from src/indexer, src/main, src/preload; and from src/renderer only the two portable
 *      helpers the SDK already inherits.
 *   5. The engine does not know about its callers: nothing under src/wiki, src/catalog, src/sync-core,
 *      src/sync-node imports src/cli/.
 */

export const WIKI_ENTRY = "src/wiki/index.ts";
export const CATALOG_ENTRY = "src/catalog/index.ts";
export const SYNC_ENTRY = "src/sync-node/index.ts";
export const SYNC_CLI_MODULE = "src/cli/sync.ts";
/** Pure rendering and unit-file I/O; it is handed its one engine fact by sync.ts and imports nothing from src/ at all. */
export const SYNC_SCHEDULE_MODULE = "src/cli/sync-schedule.ts";
export const PERMITTED_RENDERER = ["src/renderer/api/frontmatter.ts", "src/renderer/comments/model.ts"];

const srcEdges = (inputs, module) => (inputs[module]?.imports ?? []).filter((edge) => edge.path.startsWith("src/"));
const describe = (module, edge) => `${module} imports ${edge.path} (as ${JSON.stringify(edge.original)})`;

/** @param {Record<string, { imports: Array<{ path: string, original?: string }> }>} inputs */
export function auditCliImports(inputs) {
  const violations = [];
  const sources = Object.keys(inputs).filter((path) => path.startsWith("src/")).sort();

  for (const module of sources.filter((path) => path.startsWith("src/cli/"))) {
    for (const edge of srcEdges(inputs, module)) {
      const own = edge.path.startsWith("src/cli/");
      const allowed = own || edge.path === WIKI_ENTRY || edge.path === CATALOG_ENTRY || edge.path === SYNC_ENTRY;
      if (!allowed) {
        violations.push(`${describe(module, edge)}: the CLI may only reach ${WIKI_ENTRY}, ${CATALOG_ENTRY}, ${SYNC_ENTRY} and its own modules`);
      } else if (edge.path === SYNC_ENTRY && module !== SYNC_CLI_MODULE) {
        violations.push(`${describe(module, edge)}: only ${SYNC_CLI_MODULE} may import the sync engine`);
      } else if (module === SYNC_SCHEDULE_MODULE && !own) {
        violations.push(`${describe(module, edge)}: ${SYNC_SCHEDULE_MODULE} may import nothing from src/ outside src/cli/`);
      } else if (module === SYNC_CLI_MODULE && (edge.path === WIKI_ENTRY || edge.path === CATALOG_ENTRY)) {
        violations.push(`${describe(module, edge)}: ${SYNC_CLI_MODULE} may import only ${SYNC_ENTRY} (and src/cli/ siblings)`);
      }
    }
  }

  const layers = [
    ["src/sync-node/", ["src/sync-node/", "src/sync-core/", "src/shared/"]],
    ["src/sync-core/", ["src/sync-core/", "src/shared/"]],
  ];
  for (const [prefix, permitted] of layers) {
    for (const module of sources.filter((path) => path.startsWith(prefix))) {
      for (const edge of srcEdges(inputs, module)) {
        if (!permitted.some((p) => edge.path.startsWith(p))) violations.push(`${describe(module, edge)}: ${prefix} may only reach ${permitted.join(", ")}`);
      }
    }
  }

  for (const prefix of ["src/indexer/", "src/main/", "src/preload/"]) {
    for (const path of sources.filter((p) => p.startsWith(prefix))) violations.push(`${path} is in the CLI graph: nothing under ${prefix} may be`);
  }
  for (const path of sources.filter((p) => p.startsWith("src/renderer/"))) {
    if (!PERMITTED_RENDERER.includes(path)) violations.push(`${path} is in the CLI graph: only ${PERMITTED_RENDERER.join(" and ")} are inherited from src/renderer/`);
  }

  for (const prefix of ["src/wiki/", "src/catalog/", "src/sync-core/", "src/sync-node/"]) {
    for (const module of sources.filter((path) => path.startsWith(prefix))) {
      for (const edge of srcEdges(inputs, module)) {
        if (edge.path.startsWith("src/cli/")) violations.push(`${describe(module, edge)}: the engine must not import its callers`);
      }
    }
  }
  return violations;
}

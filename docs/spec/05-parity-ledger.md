# Obsidian parity ledger

The generated [`parity-ledger.json`](parity-ledger.json) is the traceability
baseline for Geode's Obsidian compatibility program. It inventories official
public requirements; it does **not** claim that Geode currently satisfies them.
Newly discovered rows default to `unknown` until a reviewer adds an explicit,
durable evidence mapping.

## Baseline and coverage

The generator reads these official repositories:

- `obsidianmd/obsidian-help`: every Markdown page below `en/`
- `obsidianmd/obsidian-developer-docs`: every Markdown page below `en/`,
  including developer guides, CSS references, top-level TypeScript API pages,
  and generated member-level API pages
- `obsidianmd/obsidian-api`: every exported top-level declaration in
  `obsidian.d.ts`, plus the public named members of classes, interfaces, enums,
  and object type aliases
- `obsidianmd/obsidian-help/Release notes`: every list-item delta in desktop
  releases 1.13.2, 1.13.3, and 1.13.4, which closes the prior 1.13.1 snapshot
  gap. This explicitly includes image lightbox, navigation, zoom/pan, and Live
  Preview image selection, resizing, editing, and layout refinements.

The checked-in baseline contains 2,850 rows: 173 help pages, 1,319 developer
pages, 50 changelog deltas, 299 public API declarations, and 1,009 public API
members. Generated IDs are a kind prefix plus the first 12 hexadecimal digits
of a SHA-256 hash over the row's canonical source identity. IDs do not depend on
filesystem location, generation time, or row order.

## Status and evidence policy

Allowed statuses are:

- `verified`: directly observed by the referenced automated test or durable QA
  artifact
- `partial`: evidence observes only part of the requirement
- `missing`: evidence demonstrates that the behavior or contract is absent
- `intentionally-equivalent`: evidence demonstrates a documented Geode-owned
  equivalent rather than identical branding or infrastructure
- `blocked`: evidence records the external/input constraint preventing closure
- `unknown`: no explicit assessment has been made

Status overrides live in [`parity-evidence.json`](parity-evidence.json), keyed
by generated requirement ID. Any status other than `unknown` requires at least
one evidence reference. Unknown IDs, invalid statuses, and evidence-free status
claims fail generation. Name matching or code inspection alone never upgrades a
row to `verified`.

Example:

```json
{
  "HELP-0123456789ab": {
    "status": "verified",
    "evidence": ["tests/e2e/example.spec.ts"],
    "notes": "Observed behavior covered by the named test."
  }
}
```

## Refresh procedure

1. Clone or update the three official repositories at the paths below and
   record their commit SHAs in the reviewing change description:

   ```sh
   git clone https://github.com/obsidianmd/obsidian-help /private/tmp/geode-audit-obsidian-help
   git clone https://github.com/obsidianmd/obsidian-developer-docs /private/tmp/geode-audit-obsidian-developer-docs
   git clone https://github.com/obsidianmd/obsidian-api /private/tmp/geode-audit-obsidian-api
   ```

2. Generate the ledger and inspect the JSON diff:

   ```sh
   npm run parity:generate
   git diff -- docs/spec/parity-ledger.json
   ```

3. Run the deterministic staleness check and targeted tests:

   ```sh
   npm run parity:check
   npm run test:unit -- --run tests/unit/parity-ledger.test.ts
   ```

Alternative clone locations can be supplied directly:

```sh
node scripts/generate-parity-ledger.mts \
  --help-root /path/to/obsidian-help \
  --developer-root /path/to/obsidian-developer-docs \
  --api-root /path/to/obsidian-api
```

The artifact contains no timestamp or absolute local path, so identical source
trees and evidence produce byte-identical output.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildParityLedger,
  renderParityLedger,
  type EvidenceMap,
} from "../../scripts/parity-ledger.mts";

async function fixtureSources(): Promise<{
  apiRoot: string;
  developerRoot: string;
  helpRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "geode-parity-ledger-"));
  const helpRoot = join(root, "obsidian-help");
  const developerRoot = join(root, "obsidian-developer-docs");
  const apiRoot = join(root, "obsidian-api");

  await mkdir(join(helpRoot, "en", "Editing"), { recursive: true });
  await mkdir(join(helpRoot, "Release notes"), { recursive: true });
  await mkdir(
    join(developerRoot, "en", "Reference", "TypeScript API", "App"),
    { recursive: true },
  );
  await mkdir(apiRoot, { recursive: true });

  await writeFile(join(helpRoot, "en", "Home.md"), "# Home\n");
  await writeFile(
    join(helpRoot, "en", "Editing", "Images.md"),
    "# Images\n",
  );
  await writeFile(
    join(helpRoot, "Release notes", "v1.13.2.md"),
    [
      "---",
      'title: "1.13.2"',
      "---",
      "# Improvements",
      "- New image lightbox.",
      "- Live Preview: Press `+` to resize a selected image.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(helpRoot, "Release notes", "v1.13.5.md"),
    "- This release is beyond the baseline.\n",
  );
  await writeFile(join(helpRoot, "Release notes", "v1.13.3.md"), "# 1.13.3\n");
  await writeFile(join(helpRoot, "Release notes", "v1.13.4.md"), "# 1.13.4\n");
  await writeFile(
    join(developerRoot, "en", "Plugins.md"),
    "# Plugins\n",
  );
  await writeFile(
    join(
      developerRoot,
      "en",
      "Reference",
      "TypeScript API",
      "App.md",
    ),
    "# App\n",
  );
  await writeFile(
    join(
      developerRoot,
      "en",
      "Reference",
      "TypeScript API",
      "App",
      "vault.md",
    ),
    "# App.vault\n",
  );
  await writeFile(
    join(apiRoot, "obsidian.d.ts"),
    [
      "export declare class App {",
      "  vault: Vault;",
      "  open(): void;",
      "  private secret: string;",
      "}",
      "export interface Vault { read(path: string): Promise<string>; }",
      "declare class InternalOnly {}",
      "export declare function normalizePath(path: string): string;",
      "",
    ].join("\n"),
  );

  return { apiRoot, developerRoot, helpRoot };
}

describe("parity ledger", () => {
  it("inventories official pages, release deltas, and public API declarations with stable IDs", async () => {
    const roots = await fixtureSources();
    const first = await buildParityLedger({ ...roots, evidence: {} });
    const second = await buildParityLedger({ ...roots, evidence: {} });

    expect(second).toEqual(first);
    expect(first.requirements.filter((row) => row.kind === "help-page")).toHaveLength(2);
    expect(
      first.requirements.filter((row) => row.kind === "developer-page"),
    ).toHaveLength(3);
    expect(
      first.requirements.filter((row) => row.kind === "changelog-delta"),
    ).toHaveLength(2);
    expect(
      first.requirements.some((row) => row.sourcePath.includes("v1.13.5")),
    ).toBe(false);

    const apiRows = first.requirements.filter((row) => row.kind.startsWith("api-"));
    expect(apiRows.map((row) => row.title)).toEqual([
      "App",
      "normalizePath",
      "Vault",
      "App.open",
      "App.vault",
      "Vault.read",
    ]);
    expect(apiRows.some((row) => row.title.includes("secret"))).toBe(false);
    expect(new Set(first.requirements.map((row) => row.id)).size).toBe(
      first.requirements.length,
    );
  });

  it("defaults every row to unknown and only applies valid explicit evidence", async () => {
    const roots = await fixtureSources();
    const baseline = await buildParityLedger({ ...roots, evidence: {} });
    expect(new Set(baseline.requirements.map((row) => row.status))).toEqual(
      new Set(["unknown"]),
    );

    const target = baseline.requirements.find(
      (row) => row.kind === "help-page" && row.title === "Home",
    );
    expect(target).toBeDefined();
    const evidence: EvidenceMap = {
      [target!.id]: {
        status: "verified",
        evidence: ["tests/e2e/smoke.spec.ts"],
        notes: "Observed by the vault-open smoke test.",
      },
    };
    const mapped = await buildParityLedger({ ...roots, evidence });
    expect(mapped.requirements.find((row) => row.id === target!.id)).toMatchObject(
      evidence[target!.id],
    );

    await expect(
      buildParityLedger({
        ...roots,
        evidence: {
          [target!.id]: { status: "verified", evidence: [] },
        },
      }),
    ).rejects.toThrow(/requires at least one evidence reference/);
    await expect(
      buildParityLedger({
        ...roots,
        evidence: {
          "HELP-does-not-exist": {
            status: "missing",
            evidence: ["docs/spec/00-overview.md"],
          },
        },
      }),
    ).rejects.toThrow(/does not match a generated requirement/);
  });

  it("renders deterministic, reviewable JSON without machine-specific source roots", async () => {
    const roots = await fixtureSources();
    const ledger = await buildParityLedger({ ...roots, evidence: {} });
    const rendered = renderParityLedger(ledger);

    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered).not.toContain(tmpdir());
    expect(JSON.parse(rendered)).toEqual(ledger);
    expect(ledger.statusVocabulary).toEqual([
      "verified",
      "partial",
      "missing",
      "intentionally-equivalent",
      "blocked",
      "unknown",
    ]);
  });
});

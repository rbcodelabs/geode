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

/**
 * A second, purpose-built fixture for the dom-surface evidence policy tests below. Kept separate
 * from `fixtureSources()` (reused above with exact-match assertions on its specific inventory) so
 * this file's obsidian.d.ts can be tailored to exercise the classifier's signals in isolation.
 */
async function domSurfaceFixtureSources(): Promise<{
  apiRoot: string;
  developerRoot: string;
  helpRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "geode-parity-ledger-dom-"));
  const helpRoot = join(root, "obsidian-help");
  const developerRoot = join(root, "obsidian-developer-docs");
  const apiRoot = join(root, "obsidian-api");

  await mkdir(join(helpRoot, "en"), { recursive: true });
  await mkdir(join(helpRoot, "Release notes"), { recursive: true });
  await mkdir(join(developerRoot, "en"), { recursive: true });
  await mkdir(apiRoot, { recursive: true });

  for (const version of ["1.13.2", "1.13.3", "1.13.4"]) {
    await writeFile(join(helpRoot, "Release notes", `v${version}.md`), `# ${version}\n`);
  }

  await writeFile(
    join(apiRoot, "obsidian.d.ts"),
    [
      "export declare class View {",
      "  containerEl: HTMLElement;",
      "  getIcon(): string;",
      "}",
      "export declare class Widget {",
      "  ping(): void;",
      "}",
      "export declare function addIcon(iconId: string, svgContent: string): void;",
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

describe("dom-surface evidence policy", () => {
  it("computes dom via the class allowlist even when the member's own type has no DOM token", async () => {
    const roots = await domSurfaceFixtureSources();
    const baseline = await buildParityLedger({ ...roots, evidence: {} });
    const target = baseline.requirements.find(
      (row) => row.kind === "api-member" && row.title === "View.getIcon",
    );
    expect(target).toBeDefined();
    // getIcon(): string carries no HTMLElement/SVGElement/etc token in its own signature; only
    // the View class-allowlist signal can catch it.
    expect(target!.surface).toBe("dom");

    await expect(
      buildParityLedger({
        ...roots,
        evidence: {
          [target!.id]: {
            status: "verified",
            evidence: ["tests/unit/view.test.ts"],
          },
        },
      }),
    ).rejects.toThrow(/tests\/e2e/);
  });

  it("succeeds once tests/e2e/ evidence is supplied for the same dom-surface row", async () => {
    const roots = await domSurfaceFixtureSources();
    const baseline = await buildParityLedger({ ...roots, evidence: {} });
    const target = baseline.requirements.find(
      (row) => row.kind === "api-member" && row.title === "View.getIcon",
    );
    expect(target).toBeDefined();

    const mapped = await buildParityLedger({
      ...roots,
      evidence: {
        [target!.id]: {
          status: "verified",
          evidence: ["tests/e2e/view-icon.spec.ts"],
        },
      },
    });
    const row = mapped.requirements.find((requirement) => requirement.id === target!.id);
    expect(row?.status).toBe("verified");
    expect(row?.surface).toBe("dom");
  });

  it("does not over-fire on a logic-only row backed by unit-test-only evidence", async () => {
    const roots = await domSurfaceFixtureSources();
    const baseline = await buildParityLedger({ ...roots, evidence: {} });
    const target = baseline.requirements.find(
      (row) => row.kind === "api-member" && row.title === "Widget.ping",
    );
    expect(target).toBeDefined();
    expect(target!.surface).toBe("logic");

    const mapped = await buildParityLedger({
      ...roots,
      evidence: {
        [target!.id]: {
          status: "verified",
          evidence: ["tests/unit/widget.test.ts"],
        },
      },
    });
    expect(
      mapped.requirements.find((requirement) => requirement.id === target!.id)?.status,
    ).toBe("verified");
  });

  it("enforces the tests/e2e/ requirement on the hand-maintained addIcon exception", async () => {
    const roots = await domSurfaceFixtureSources();
    const baseline = await buildParityLedger({ ...roots, evidence: {} });
    const target = baseline.requirements.find(
      (row) => row.kind === "api-declaration" && row.title === "addIcon",
    );
    expect(target).toBeDefined();
    // addIcon's signature (string, string) => void carries no DOM type token at all; only the
    // hand-maintained top-level function allowlist catches it.
    expect(target!.surface).toBe("dom");

    await expect(
      buildParityLedger({
        ...roots,
        evidence: {
          [target!.id]: { status: "verified", evidence: ["tests/unit/icons.test.ts"] },
        },
      }),
    ).rejects.toThrow(/tests\/e2e/);

    const mapped = await buildParityLedger({
      ...roots,
      evidence: {
        [target!.id]: { status: "verified", evidence: ["tests/e2e/icons.spec.ts"] },
      },
    });
    expect(
      mapped.requirements.find((requirement) => requirement.id === target!.id)?.status,
    ).toBe("verified");
  });

  it("requires notes whenever a row's surface is explicitly overridden", async () => {
    const roots = await domSurfaceFixtureSources();
    const baseline = await buildParityLedger({ ...roots, evidence: {} });
    const target = baseline.requirements.find(
      (row) => row.kind === "api-member" && row.title === "Widget.ping",
    );
    expect(target).toBeDefined();
    expect(target!.surface).toBe("logic");

    await expect(
      buildParityLedger({
        ...roots,
        evidence: {
          [target!.id]: {
            status: "missing",
            evidence: ["docs/spec/00-overview.md"],
            surface: "dom",
          },
        },
      }),
    ).rejects.toThrow(/notes/);

    const mapped = await buildParityLedger({
      ...roots,
      evidence: {
        [target!.id]: {
          status: "missing",
          evidence: ["docs/spec/00-overview.md"],
          surface: "dom",
          notes: "Widget.ping renders a spinner overlay despite its void return type.",
        },
      },
    });
    const row = mapped.requirements.find((requirement) => requirement.id === target!.id);
    expect(row?.surface).toBe("dom");
  });
});

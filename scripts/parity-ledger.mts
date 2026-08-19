import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

export const STATUS_VOCABULARY = [
  "verified",
  "partial",
  "missing",
  "intentionally-equivalent",
  "blocked",
  "unknown",
] as const;

export type ParityStatus = (typeof STATUS_VOCABULARY)[number];
export type RequirementKind =
  | "help-page"
  | "developer-page"
  | "changelog-delta"
  | "api-declaration"
  | "api-member";

export interface EvidenceEntry {
  status: ParityStatus;
  evidence: string[];
  notes?: string;
}

export type EvidenceMap = Record<string, EvidenceEntry>;

export interface ParityRequirement {
  id: string;
  kind: RequirementKind;
  category: string;
  title: string;
  sourcePath: string;
  sourceLink: string;
  status: ParityStatus;
  evidence: string[];
  notes?: string;
}

export interface ParityLedger {
  schemaVersion: 1;
  baseline: {
    changelog: "desktop-1.13.4";
    sources: Array<{ name: string; url: string; ref: "master" }>;
  };
  statusVocabulary: readonly ParityStatus[];
  summary: {
    total: number;
    byKind: Record<RequirementKind, number>;
    byStatus: Record<ParityStatus, number>;
  };
  requirements: ParityRequirement[];
}

export interface BuildParityLedgerOptions {
  helpRoot: string;
  developerRoot: string;
  apiRoot: string;
  evidence: EvidenceMap;
}

interface RequirementSeed {
  canonicalKey: string;
  kind: RequirementKind;
  category: string;
  title: string;
  sourcePath: string;
  sourceLink: string;
}

const SOURCE_URLS = {
  help: "https://github.com/obsidianmd/obsidian-help/blob/master/",
  developer:
    "https://github.com/obsidianmd/obsidian-developer-docs/blob/master/",
  api: "https://github.com/obsidianmd/obsidian-api/blob/master/",
} as const;

const KIND_ORDER: Record<RequirementKind, number> = {
  "help-page": 0,
  "developer-page": 1,
  "changelog-delta": 2,
  "api-declaration": 3,
  "api-member": 4,
};

const KIND_PREFIX: Record<RequirementKind, string> = {
  "help-page": "HELP",
  "developer-page": "DEV",
  "changelog-delta": "CHANGE",
  "api-declaration": "API",
  "api-member": "API-MEMBER",
};

const CHANGELOG_VERSIONS = ["1.13.2", "1.13.3", "1.13.4"] as const;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function encodeSourcePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function titleFromPath(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return filename.replace(/\.md$/u, "");
}

function stableId(kind: RequirementKind, canonicalKey: string): string {
  const digest = createHash("sha256").update(canonicalKey).digest("hex").slice(0, 12);
  return `${KIND_PREFIX[kind]}-${digest}`;
}

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        output.push(toPosix(relative(root, absolute)));
      }
    }
  }
  await visit(root);
  return output;
}

function helpCategory(path: string): string {
  const segments = path.split("/");
  return segments.length > 2 ? segments[1] : "General";
}

function developerCategory(path: string): string {
  if (path.includes("/Reference/TypeScript API/")) return "TypeScript API reference";
  if (path.includes("/Reference/CSS variables/")) return "CSS reference";
  if (path.includes("/Reference/")) return "Developer reference";
  if (path.includes("/Plugins/")) return "Plugin developer guide";
  return "Developer guide";
}

async function helpPageSeeds(helpRoot: string): Promise<RequirementSeed[]> {
  const englishRoot = resolve(helpRoot, "en");
  return (await markdownFiles(englishRoot)).map((englishPath) => {
    const sourcePath = `en/${englishPath}`;
    return {
      canonicalKey: `help:${sourcePath}`,
      kind: "help-page",
      category: helpCategory(sourcePath),
      title: titleFromPath(sourcePath),
      sourcePath: `obsidian-help/${sourcePath}`,
      sourceLink: `${SOURCE_URLS.help}${encodeSourcePath(sourcePath)}`,
    };
  });
}

async function developerPageSeeds(developerRoot: string): Promise<RequirementSeed[]> {
  const englishRoot = resolve(developerRoot, "en");
  return (await markdownFiles(englishRoot)).map((englishPath) => {
    const sourcePath = `en/${englishPath}`;
    return {
      canonicalKey: `developer:${sourcePath}`,
      kind: "developer-page",
      category: developerCategory(sourcePath),
      title: titleFromPath(sourcePath),
      sourcePath: `obsidian-developer-docs/${sourcePath}`,
      sourceLink: `${SOURCE_URLS.developer}${encodeSourcePath(sourcePath)}`,
    };
  });
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_]/gu, "")
    .trim();
}

async function changelogSeeds(helpRoot: string): Promise<RequirementSeed[]> {
  const seeds: RequirementSeed[] = [];
  for (const version of CHANGELOG_VERSIONS) {
    const repositoryPath = `Release notes/v${version}.md`;
    const content = await readFile(resolve(helpRoot, repositoryPath), "utf8");
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*-\s+(.+)$/u.exec(lines[index]);
      if (!match) continue;
      const description = stripMarkdown(match[1]);
      const canonicalKey = `changelog:${version}:${description}`;
      seeds.push({
        canonicalKey,
        kind: "changelog-delta",
        category: `Desktop ${version}`,
        title: description,
        sourcePath: `obsidian-help/${repositoryPath}#L${index + 1}`,
        sourceLink: `${SOURCE_URLS.help}${encodeSourcePath(repositoryPath)}#L${index + 1}`,
      });
    }
  }
  return seeds;
}

function isExported(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function nodeName(node: ts.NamedDeclaration): string | undefined {
  if (!node.name) return undefined;
  if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) return node.name.text;
  if (ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text;
  return node.name.getText();
}

function isPrivateMember(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword),
  );
}

function memberNames(node: ts.Node): string[] {
  let members: ts.NodeArray<ts.TypeElement | ts.ClassElement | ts.EnumMember> | undefined;
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) members = node.members;
  else if (ts.isEnumDeclaration(node)) members = node.members;
  else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    members = node.type.members;
  }
  if (!members) return [];

  const names = new Set<string>();
  for (const member of members) {
    if (isPrivateMember(member)) continue;
    if (ts.isConstructorDeclaration(member)) names.add("(constructor)");
    else if ("name" in member) {
      const name = nodeName(member as ts.NamedDeclaration);
      if (name && !name.startsWith("#")) names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, "en"));
}

function declarationNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) =>
        ts.isIdentifier(declaration.name) ? declaration.name.text : undefined,
      )
      .filter((name): name is string => Boolean(name));
  }
  if (
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name ? [statement.name.getText()] : [];
  }
  return [];
}

async function apiSeeds(apiRoot: string): Promise<RequirementSeed[]> {
  const repositoryPath = "obsidian.d.ts";
  const absolutePath = resolve(apiRoot, repositoryPath);
  const content = await readFile(absolutePath, "utf8");
  const source = ts.createSourceFile(
    repositoryPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const seeds = new Map<string, RequirementSeed>();

  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    for (const name of declarationNames(statement)) {
      const topKey = `api:${name}`;
      seeds.set(topKey, {
        canonicalKey: topKey,
        kind: "api-declaration",
        category: "Plugin API",
        title: name,
        sourcePath: `obsidian-api/${repositoryPath}`,
        sourceLink: `${SOURCE_URLS.api}${repositoryPath}`,
      });
      for (const member of memberNames(statement)) {
        const memberKey = `api:${name}.${member}`;
        seeds.set(memberKey, {
          canonicalKey: memberKey,
          kind: "api-member",
          category: "Plugin API member",
          title: `${name}.${member}`,
          sourcePath: `obsidian-api/${repositoryPath}`,
          sourceLink: `${SOURCE_URLS.api}${repositoryPath}`,
        });
      }
    }
  }
  return [...seeds.values()];
}

function validateEvidence(id: string, entry: EvidenceEntry): void {
  if (!STATUS_VOCABULARY.includes(entry.status)) {
    throw new Error(`${id} has invalid status: ${String(entry.status)}`);
  }
  if (entry.status !== "unknown" && entry.evidence.length === 0) {
    throw new Error(`${id} status ${entry.status} requires at least one evidence reference`);
  }
}

function countBy<T extends string>(values: readonly T[], vocabulary: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(vocabulary.map((value) => [value, 0])) as Record<T, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}

export async function buildParityLedger(
  options: BuildParityLedgerOptions,
): Promise<ParityLedger> {
  const seeds = [
    ...(await helpPageSeeds(options.helpRoot)),
    ...(await developerPageSeeds(options.developerRoot)),
    ...(await changelogSeeds(options.helpRoot)),
    ...(await apiSeeds(options.apiRoot)),
  ];
  seeds.sort(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.sourcePath.localeCompare(right.sourcePath, "en") ||
      left.title.localeCompare(right.title, "en"),
  );

  const generatedIds = new Set<string>();
  const requirements = seeds.map((seed): ParityRequirement => {
    const id = stableId(seed.kind, seed.canonicalKey);
    if (generatedIds.has(id)) throw new Error(`Stable requirement ID collision: ${id}`);
    generatedIds.add(id);
    const explicit = options.evidence[id];
    if (explicit) validateEvidence(id, explicit);
    return {
      id,
      kind: seed.kind,
      category: seed.category,
      title: seed.title,
      sourcePath: seed.sourcePath,
      sourceLink: seed.sourceLink,
      status: explicit?.status ?? "unknown",
      evidence: explicit?.evidence ?? [],
      ...(explicit?.notes ? { notes: explicit.notes } : {}),
    };
  });

  for (const id of Object.keys(options.evidence)) {
    if (!generatedIds.has(id)) {
      throw new Error(`Evidence ID ${id} does not match a generated requirement`);
    }
  }

  const kinds: RequirementKind[] = [
    "help-page",
    "developer-page",
    "changelog-delta",
    "api-declaration",
    "api-member",
  ];
  return {
    schemaVersion: 1,
    baseline: {
      changelog: "desktop-1.13.4",
      sources: [
        { name: "obsidian-help", url: "https://github.com/obsidianmd/obsidian-help", ref: "master" },
        {
          name: "obsidian-developer-docs",
          url: "https://github.com/obsidianmd/obsidian-developer-docs",
          ref: "master",
        },
        { name: "obsidian-api", url: "https://github.com/obsidianmd/obsidian-api", ref: "master" },
      ],
    },
    statusVocabulary: STATUS_VOCABULARY,
    summary: {
      total: requirements.length,
      byKind: countBy(
        requirements.map((requirement) => requirement.kind),
        kinds,
      ),
      byStatus: countBy(
        requirements.map((requirement) => requirement.status),
        STATUS_VOCABULARY,
      ),
    },
    requirements,
  };
}

export function renderParityLedger(ledger: ParityLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

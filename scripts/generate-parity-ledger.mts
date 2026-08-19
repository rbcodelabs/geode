import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildParityLedger,
  renderParityLedger,
  type EvidenceMap,
} from "./parity-ledger.mts";

interface CliOptions {
  helpRoot: string;
  developerRoot: string;
  apiRoot: string;
  evidencePath: string;
  outputPath: string;
  check: boolean;
}

function parseArguments(argv: string[]): CliOptions {
  const values: CliOptions = {
    helpRoot: "/private/tmp/geode-audit-obsidian-help",
    developerRoot: "/private/tmp/geode-audit-obsidian-developer-docs",
    apiRoot: "/private/tmp/geode-audit-obsidian-api",
    evidencePath: "docs/spec/parity-evidence.json",
    outputPath: "docs/spec/parity-ledger.json",
    check: false,
  };
  const pathFlags: Record<string, keyof Omit<CliOptions, "check">> = {
    "--help-root": "helpRoot",
    "--developer-root": "developerRoot",
    "--api-root": "apiRoot",
    "--evidence": "evidencePath",
    "--output": "outputPath",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      values.check = true;
      continue;
    }
    const key = pathFlags[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a path`);
    values[key] = value;
    index += 1;
  }
  return values;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const evidence = JSON.parse(
    await readFile(resolve(options.evidencePath), "utf8"),
  ) as EvidenceMap;
  const ledger = await buildParityLedger({
    helpRoot: resolve(options.helpRoot),
    developerRoot: resolve(options.developerRoot),
    apiRoot: resolve(options.apiRoot),
    evidence,
  });
  const rendered = renderParityLedger(ledger);
  const outputPath = resolve(options.outputPath);

  if (options.check) {
    const current = await readFile(outputPath, "utf8");
    if (current !== rendered) {
      throw new Error(
        `${options.outputPath} is stale; run npm run parity:generate and commit the result`,
      );
    }
    console.log(`Parity ledger is current (${ledger.summary.total} requirements).`);
    return;
  }

  await writeFile(outputPath, rendered);
  console.log(`Wrote ${options.outputPath} (${ledger.summary.total} requirements).`);
}

await main();

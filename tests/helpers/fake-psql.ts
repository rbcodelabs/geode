import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in for `psql` that the adapter drives over real pipes.
 *
 * The adapter spawns `psql` with a fixed argument list and talks to it over
 * stdin/stdout, so the only seam a test can reach is the executable itself —
 * `createPostgresCatalog({ psql })`. This writes a small Node program to a
 * temp directory and returns its path.
 *
 * It is deliberately a *real child process*, not a mock stream. The defect
 * these fixtures exist for lives in how a parent decodes bytes arriving from a
 * pipe in arbitrarily-sized chunks; a hand-fed in-process stream would hand
 * the adapter whatever chunking the test author imagined and prove nothing.
 *
 * Modes, selected by `FAKE_PSQL_MODE`:
 *
 * - `echo` — write the received stdin straight back out, so a test can observe
 *   the exact SQL the adapter sent, session prefix included.
 * - `payload` — write `FAKE_PSQL_PAYLOAD` out in two deliberate pieces, split
 *   at byte offset `FAKE_PSQL_SPLIT`, with a pause between them so the parent
 *   necessarily observes two separate `data` events at that exact boundary.
 */
const PROGRAM = `#!/usr/bin/env node
import { readFileSync } from "node:fs";

const mode = process.env.FAKE_PSQL_MODE;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (mode === "echo") {
    process.stdout.write(stdin);
    return;
  }
  const payload = readFileSync(process.env.FAKE_PSQL_PAYLOAD);
  const at = Number(process.env.FAKE_PSQL_SPLIT);
  process.stdout.write(payload.subarray(0, at));
  // The pause is the point. Without it the two writes may coalesce into one
  // read on the parent side and the forced boundary would quietly vanish,
  // leaving a test that passes because it stopped testing anything.
  setTimeout(() => { process.stdout.write(payload.subarray(at)); }, 25);
});
`;

export interface FakePsql {
  /** Path to pass as the `psql` option of `createPostgresCatalog`. */
  readonly path: string;
  readonly directory: string;
}

export async function writeFakePsql(): Promise<FakePsql> {
  const directory = await mkdtemp(join(tmpdir(), "geode-fake-psql-"));
  const path = join(directory, "fake-psql.mjs");
  await writeFile(path, PROGRAM, "utf8");
  await chmod(path, 0o755);
  return { path, directory };
}

/**
 * A byte offset strictly inside a multi-byte UTF-8 character.
 *
 * A continuation byte is `10xxxxxx`, which can only occur after a lead byte —
 * so an offset pointing at one is, by definition, a boundary that bisects a
 * character. Searching forward from a caller-supplied start keeps the choice
 * derived from the payload rather than hard-coded against it.
 */
export function continuationByteOffset(payload: Buffer, from: number): number {
  for (let at = from; at < payload.length; at += 1) {
    if ((payload[at] & 0xc0) === 0x80) return at;
  }
  throw new Error("payload contains no multi-byte character after the requested offset");
}

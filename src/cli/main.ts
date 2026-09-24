/**
 * The `geode-wiki` binary's entry point.
 *
 * Deliberately five lines. Everything testable lives in `./geode-wiki`, which
 * takes its streams and environment as arguments — so the proof harness and the
 * unit tests drive the same `run()` the binary does, and this file is the only
 * part that is not covered by a test because there is nothing in it to cover.
 *
 * `process.exitCode` rather than `process.exit()`: the latter truncates a
 * pending `stdout` write when stdout is a pipe, which is exactly the case for
 * `geode-wiki list --json | jq`.
 */

import { run } from "./geode-wiki";

process.exitCode = await run(process.argv.slice(2), {
  streams: {
    out: (text) => { process.stdout.write(text); },
    err: (text) => { process.stderr.write(text); },
  },
  env: process.env,
  stdin: process.stdin,
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { E2E_TMP_PREFIX, isE2ETempDir, shouldReapProcess } from "../../scripts/e2e-reap.mts";
import { FRESH_DOCUMENTS_PREFIX, FRESH_USER_DATA_PREFIX } from "../../scripts/fresh-instance-paths.mts";

/**
 * `npm run fresh` temp dirs must never be claimable by the e2e reaper, or
 * `npm run e2e:kill` (and the suite's setup/teardown) would kill the instance.
 */
describe("fresh-instance temp dir naming", () => {
  for (const [label, prefix] of [
    ["user-data", FRESH_USER_DATA_PREFIX],
    ["documents", FRESH_DOCUMENTS_PREFIX],
  ] as const) {
    it(`${label} prefix does not start with the e2e reaper prefix`, () => {
      expect(prefix.startsWith(E2E_TMP_PREFIX)).toBe(false);
    });

    it(`${label} dir made by mkdtemp is not an e2e temp dir`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      try {
        expect(isE2ETempDir(dir, os.tmpdir())).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("reaper would not kill an electron process launched with the fresh user-data dir", () => {
    const tmp = os.tmpdir();
    const cmd = `/x/electron /repo --user-data-dir=${path.join(tmp, `${FRESH_USER_DATA_PREFIX}AbC123`)}`;
    expect(shouldReapProcess(cmd, tmp, "/repo")).toBe(false);
    expect(shouldReapProcess(cmd, tmp)).toBe(false);
  });

  it("sanity: the reaper does claim a geode- user-data dir", () => {
    const tmp = os.tmpdir();
    const cmd = `/x/electron /repo --user-data-dir=${path.join(tmp, "geode-e2e-AbC123")}`;
    expect(shouldReapProcess(cmd, tmp, "/repo")).toBe(true);
  });
});

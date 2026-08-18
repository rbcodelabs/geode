import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("acquires and safely releases a native power-save blocker through the preload API", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-power-save-blocker-"));
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    const result = await window.evaluate(async () => {
      const token = await window.geode.acquirePowerSaveBlocker();
      const firstRelease = await window.geode.releasePowerSaveBlocker(token);
      const duplicateRelease = await window.geode.releasePowerSaveBlocker(token);
      return { token, firstRelease, duplicateRelease };
    });

    expect(result.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(result.firstRelease).toBe(true);
    expect(result.duplicateRelease).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

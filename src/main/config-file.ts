import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

interface AtomicOps { rename(from: string, to: string): Promise<void> }

/** Same-directory write + rename prevents interrupted config writes from truncating the last good file. */
export async function writeJsonAtomic(target: string, data: unknown, ops: AtomicOps = fsp): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fsp.writeFile(temp, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
    await ops.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

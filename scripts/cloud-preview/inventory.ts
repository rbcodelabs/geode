import { open } from "node:fs/promises";
import { dirname } from "node:path";

export interface PreviewInventory {
  version: 1;
  schema: string;
  denialSchema: string;
  tables: string[];
  createdAt: string;
  expiresAt: string;
  target: { teamId: string; projectId: string; host: string; region: string; roleArn: string; blobStoreId: string };
  blobKeys: string[];
}
function assert(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid exact preview inventory"); }
function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
  assert(Object.keys(value).sort().join(",") === keys.sort().join(","));
}
export function validateInventory(value: unknown): PreviewInventory {
  exactKeys(value,["version","schema","denialSchema","tables","createdAt","expiresAt","target","blobKeys"]);
  assert(value.version === 1 && typeof value.schema === "string" && /^geode_wiki_preview_[a-f0-9]{16}$/.test(value.schema));
  assert(value.denialSchema === value.schema + "_deny");
  assert(JSON.stringify(value.tables) === JSON.stringify(["receipt","catalog_entry","object","vault_sequence"]));
  assert(typeof value.createdAt === "string" && typeof value.expiresAt === "string");
  const duration = Date.parse(value.expiresAt) - Date.parse(value.createdAt);
  assert(Number.isFinite(duration) && duration > 0 && duration <= 86_400_000);
  exactKeys(value.target,["teamId","projectId","host","region","roleArn","blobStoreId"]);
  const t = value.target;
  assert(typeof t.teamId === "string" && /^team_[A-Za-z0-9]+$/.test(t.teamId));
  assert(typeof t.projectId === "string" && /^prj_[A-Za-z0-9]+$/.test(t.projectId));
  assert(typeof t.region === "string" && /^[a-z]{2}-[a-z]+-[1-9]$/.test(t.region));
  assert(typeof t.host === "string" && /^[a-z0-9]+\.dsql\.[a-z0-9-]+\.on\.aws$/.test(t.host) && t.host.endsWith(`.dsql.${t.region}.on.aws`));
  assert(typeof t.roleArn === "string" && /^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(t.roleArn));
  assert(typeof t.blobStoreId === "string" && /^[A-Za-z0-9]+$/.test(t.blobStoreId));
  assert(Array.isArray(value.blobKeys) && value.blobKeys.length > 0 && value.blobKeys.length <= 100);
  assert(new Set(value.blobKeys).size === value.blobKeys.length);
  for (const key of value.blobKeys) assert(typeof key === "string" && key.startsWith(value.schema + "/") && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/objects\/[a-f0-9]{64}$/.test(key.slice(value.schema.length + 1)));
  // Reconstruct from the validated JSON so later caller mutation cannot change authority.
  return JSON.parse(JSON.stringify(value)) as PreviewInventory;
}
/** Exclusive, fsynced, owner-only file. It is a recovery authority, never a best-effort log. */
export async function saveInventory(path: string, value: unknown): Promise<void> {
  const inventory = validateInventory(value);
  const file = await open(path,"wx",0o600);
  try { await file.writeFile(JSON.stringify(inventory,null,2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dirname(path),"r");
  try { await directory.sync(); } finally { await directory.close(); }
}

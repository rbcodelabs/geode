/** Private fixed-resource protocol. No application or filesystem authority crosses it. */
export const BUILD = "image-parser-packed-v1";
export const ORIGIN = "geode-image-parser://broker";
export const READY_MS = 8_000;
export const PARSE_MS = 30_000;
export interface ParserSession { version: 1; build: typeof BUILD; epoch: number; nonce: string }
export type ParserInit = ParserSession & { kind: "initialize" };
export type ParserRequest = ParserSession & ({ kind: "parse"; request: number; source: string } | { kind: "cancel"; request: number } | { kind: "close" });
export type ParserReply = ParserSession & ({ kind: "ready" } | { kind: "closed" } | { kind: "worker-ready"; request: number } | { kind: "parsed"; request: number; payload: unknown } | { kind: "cancelled"; request: number; released: true } | { kind: "failed"; request: number; code: "worker-error" | "invalid-result" });
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const sessionKeys = ["kind", "version", "build", "epoch", "nonce"];
const exact = (value: Record<string, unknown>, extra: string[] = []) => {
  const keys = [...sessionKeys, ...extra];
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
};
function identity(value: Record<string, unknown>, session?: ParserSession): boolean {
  return value.version === 1 && value.build === BUILD && positive(value.epoch) && typeof value.nonce === "string" && /^[a-f0-9]{64}$/.test(value.nonce)
    && (!session || value.epoch === session.epoch && value.nonce === session.nonce && value.build === session.build);
}
export function isParserInit(value: unknown): value is ParserInit {
  return record(value) && identity(value) && value.kind === "initialize" && exact(value);
}
export function isParserRequest(value: unknown, session: ParserSession): value is ParserRequest {
  if (!record(value) || !identity(value, session)) return false;
  if (value.kind === "close") return exact(value);
  if (!positive(value.request)) return false;
  if (value.kind === "cancel") return exact(value, ["request"]);
  return value.kind === "parse" && exact(value, ["request", "source"]) && typeof value.source === "string" && value.source.length <= 300_000 && !value.source.includes("\r");
}
export function isParserReply(value: unknown, session: ParserSession): value is ParserReply {
  if (!record(value) || !identity(value, session)) return false;
  if (value.kind === "ready" || value.kind === "closed") return exact(value);
  if (!positive(value.request)) return false;
  if (value.kind === "worker-ready") return exact(value, ["request"]);
  if (value.kind === "parsed") return exact(value, ["request", "payload"]);
  if (value.kind === "cancelled") return exact(value, ["request", "released"]) && value.released === true;
  return value.kind === "failed" && exact(value, ["request", "code"]) && (value.code === "worker-error" || value.code === "invalid-result");
}

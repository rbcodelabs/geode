import { b64uDecode, b64uEncode } from "./crypto";
import { PairingError } from "./errors";

/** What the QR holds. Docs: docs/design/mobile-qr-pairing.md "Invitation". No configuration and no credential. */
export interface PairingInvitation {
  sessionId: string;   // 16 random bytes, base64url
  token: string;       // 16 random bytes, base64url: the pairing secret
  fingerprint: string; // 16 bytes of SHA-256(desktop ephemeral public key), base64url
  expiresAt: number;   // unix seconds
  addresses: string[]; // "host:port"
}

export const INVITATION_PREFIX = "geode-pair1.";
export const MAX_INVITATION_CHARS = 512;
export const MAX_ADDRESSES = 4;
export const MAX_ADDRESS_CHARS = 80;
export const PAIRING_TTL_MS = 3 * 60 * 1000;

const invalid = (message = "This isn't a valid Geode pairing code."): never => { throw new PairingError("invalid-invitation", message); };

/** RFC 1918, link-local, tailnet CGNAT, loopback, IPv6 ULA/link-local/loopback (and v4-mapped forms of those). Literals only. */
export function isPrivateAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase().split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare); if (mapped) return isPrivateAddress(mapped[1]);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const o = v4.slice(1).map(Number); if (o.some(n => n > 255)) return false;
    return o[0] === 10 || o[0] === 127 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127);
  }
  if (!bare.includes(":")) return false;
  return bare === "::1" || /^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare);
}

/** A cleartext pairing address: a private literal, or a `.local` / `.ts.net` name, with a port. https:// (relay) is not supported in v1. */
export function parsePairingAddress(address: unknown): { host: string; port: number } {
  if (typeof address !== "string" || address.length === 0 || address.length > MAX_ADDRESS_CHARS || !/^[\x21-\x7e]+$/.test(address)) return invalid();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) throw new PairingError("relay-unsupported", "This pairing code needs a newer version of Geode.");
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(address); if (!match) return invalid();
  const port = Number(match[2]); if (port < 1 || port > 65535) return invalid();
  const host = match[1];
  const named = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(local|ts\.net)$/i.test(host);
  if (!named && !isPrivateAddress(host)) return invalid("This pairing code points outside your local network, so it was rejected.");
  return { host, port };
}

export function encodeInvitation(invitation: PairingInvitation): string {
  const json = JSON.stringify([1, invitation.sessionId, invitation.token, invitation.fingerprint, invitation.expiresAt, invitation.addresses]);
  return INVITATION_PREFIX + b64uEncode(new TextEncoder().encode(json));
}

const fixed = (value: unknown, bytes: number): string => { const raw = b64uDecode(value); if (!raw || raw.length !== bytes) return invalid(); return value as string; };

/** Untrusted input: the QR, or text pasted by the user. `nowMs` is injectable for tests. */
export function parseInvitation(text: unknown, nowMs = Date.now()): PairingInvitation {
  if (typeof text !== "string") return invalid();
  const value = text.trim();
  if (value.length > MAX_INVITATION_CHARS) return invalid();
  if (/^geode-pair\d+\./.test(value) && !value.startsWith(INVITATION_PREFIX)) throw new PairingError("unsupported-version", "This pairing code needs a newer version of Geode.");
  if (!value.startsWith(INVITATION_PREFIX)) return invalid();
  const bytes = b64uDecode(value.slice(INVITATION_PREFIX.length)); if (!bytes) return invalid();
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
  if (!Array.isArray(raw) || raw.length !== 6) return invalid();
  if (raw[0] !== 1) throw new PairingError("unsupported-version", "This pairing code needs a newer version of Geode.");
  const [, sessionId, token, fingerprint, expiresAt, addresses] = raw as unknown[];
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return invalid();
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_ADDRESSES) return invalid();
  const parsed: PairingInvitation = { sessionId: fixed(sessionId, 16), token: fixed(token, 16), fingerprint: fixed(fingerprint, 16), expiresAt, addresses: addresses.map(a => { parsePairingAddress(a); return a as string; }) };
  if (expiresAt * 1000 <= nowMs) throw new PairingError("expired", "This pairing code has expired. Show a new one on your computer.");
  return parsed;
}

import * as http from "node:http";
import * as os from "node:os";
import { b64uDecode, b64uEncode, deriveSessionKey, generateKeyPair, keyFingerprint, randomBytes, sealBundle, verifyRedeemProof } from "../shared/pairing/crypto";
import { PairingError } from "../shared/pairing/errors";
import { serializeBundle, type PairingBundle } from "../shared/pairing/bundle";
import { encodeInvitation, isPrivateAddress, PAIRING_TTL_MS } from "../shared/pairing/invitation";
import { PAIRING_PATH } from "../shared/pairing/client";

/** Limits (docs/design/mobile-qr-pairing.md "Expiry, single use, rate limit, revocation"). */
export const MAX_FAILED_ATTEMPTS = 5;
export const MAX_SESSIONS_PER_WINDOW = 3;
export const SESSION_RATE_WINDOW_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 4096;
const ALLOWED_ORIGIN = /^(capacitor|ionic):\/\/localhost$|^https?:\/\/localhost(:\d+)?$/;

export type PairingEvent = { type: "redeemed" | "expired" | "cancelled" | "too-many-attempts" };
export interface PairingStartResult { invitation: string; expiresAt: number; addresses: string[] }
export interface PairingServiceOptions {
  now?: () => number;
  ttlMs?: number;
  /** Addresses (without port) to advertise. Default: this machine's private IPv4/IPv6 interface addresses. */
  addresses?: () => string[];
  /** Interface to bind. Default 0.0.0.0 (private peers only are served). Tests bind loopback. */
  bindHost?: string;
  onEvent?: (owner: string, event: PairingEvent) => void;
}

interface Session {
  owner: string; sessionId: string; token: Uint8Array; keys: Awaited<ReturnType<typeof generateKeyPair>>; bundle: Uint8Array;
  expiresAt: number; failures: number; server: http.Server; timer: ReturnType<typeof setTimeout>;
}

export function privateInterfaceAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries ?? []) {
    if (entry.internal || entry.family !== "IPv4" || !isPrivateAddress(entry.address)) continue;
    found.push(entry.address);
  }
  // Prefer LAN over tailnet over anything else is unnecessary: the phone tries them all in order.
  return found.slice(0, 4);
}

export class PairingService {
  private readonly sessions = new Map<string, Session>();
  private readonly starts: number[] = [];
  private readonly now: () => number;
  constructor(private readonly options: PairingServiceOptions = {}) { this.now = options.now ?? Date.now; }

  /** Number of live sessions (tests, diagnostics). */
  get liveCount(): number { return this.sessions.size; }

  async start(owner: string, bundle: PairingBundle): Promise<PairingStartResult> {
    const plaintext = serializeBundle(bundle); // validates; throws PairingError("invalid-bundle")
    this.cancel(owner); // one live session per window
    const nowMs = this.now();
    while (this.starts.length && nowMs - this.starts[0] > SESSION_RATE_WINDOW_MS) this.starts.shift();
    if (this.starts.length >= MAX_SESSIONS_PER_WINDOW) throw new PairingError("rate-limited", "Too many pairing codes were created recently. Wait a few minutes and try again.");
    const hosts = (this.options.addresses ?? privateInterfaceAddresses)();
    if (hosts.length === 0) throw new PairingError("no-network-interface", "This computer has no local network address to pair over. Connect to Wi-Fi or Ethernet and try again.");
    const keys = await generateKeyPair();
    const sessionId = b64uEncode(randomBytes(16)), token = randomBytes(16);
    const ttl = this.options.ttlMs ?? PAIRING_TTL_MS;
    const server = http.createServer((req, res) => { void this.handle(sessionId, req, res); });
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 40;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, this.options.bindHost ?? "0.0.0.0", () => { server.off("error", reject); resolve(); }); });
    const port = (server.address() as { port: number }).port;
    const expiresAt = nowMs + ttl;
    const timer = setTimeout(() => this.end(sessionId, { type: "expired" }), ttl); timer.unref?.();
    this.starts.push(nowMs);
    this.sessions.set(sessionId, { owner, sessionId, token, keys, bundle: plaintext, expiresAt, failures: 0, server, timer });
    const addresses = hosts.map(host => host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);
    const invitation = encodeInvitation({ sessionId, token: b64uEncode(token), fingerprint: b64uEncode(await keyFingerprint(keys.publicKey)), expiresAt: Math.floor(expiresAt / 1000), addresses });
    return { invitation, expiresAt, addresses };
  }

  cancel(owner: string): void { for (const session of [...this.sessions.values()]) if (session.owner === owner) this.end(session.sessionId, { type: "cancelled" }); }
  closeAll(): void { for (const session of [...this.sessions.values()]) this.end(session.sessionId, { type: "cancelled" }); }

  /** Idempotent: drops secrets and closes the listener synchronously. */
  private end(sessionId: string, event: PairingEvent): void {
    const session = this.sessions.get(sessionId); if (!session) return;
    this.sessions.delete(sessionId); clearTimeout(session.timer);
    session.bundle.fill(0); session.token.fill(0);
    this.closeListener(session.server);
    this.options.onEvent?.(session.owner, event);
  }

  /** Stops accepting at once; lingering connections get a moment to flush an in-flight answer, then are cut. */
  private closeListener(server: http.Server): void { server.close(); const cut = setTimeout(() => server.closeAllConnections?.(), 250); cut.unref?.(); }

  private reply(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text), "x-content-type-options": "nosniff", ...(origin && ALLOWED_ORIGIN.test(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}) });
    res.end(text);
  }

  private async handle(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const peer = req.socket.remoteAddress ?? "";
    if (!isPrivateAddress(peer)) { req.socket.destroy(); return; } // a public peer gets no response at all
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "OPTIONS" && path === PAIRING_PATH) {
      if (!origin || !ALLOWED_ORIGIN.test(origin)) return this.reply(res, 403, undefined);
      res.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "60", vary: "Origin" }); res.end(); return;
    }
    if (req.method !== "POST" || path !== PAIRING_PATH) return this.reply(res, req.method === "POST" ? 404 : 405, { e: "denied" }, origin);
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return this.reply(res, 415, { e: "denied" }, origin);
    const declared = Number(req.headers["content-length"] ?? "0"); if (declared > MAX_BODY_BYTES) { this.reply(res, 413, { e: "denied" }, origin); req.socket.destroy(); return; }
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY_BYTES) { this.reply(res, 413, { e: "denied" }, origin); req.socket.destroy(); return; } chunks.push(chunk as Buffer); }
    } catch { return; }
    const session = this.sessions.get(sessionId);
    const deny = () => this.reply(res, 401, { e: "denied" }, origin);
    if (!session || this.now() >= session.expiresAt) { deny(); if (session) this.end(sessionId, { type: "expired" }); return; }
    let parsed: { s?: unknown; k?: unknown; p?: unknown };
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return this.fail(session, deny); }
    const phonePublic = b64uDecode(parsed?.k), proof = b64uDecode(parsed?.p);
    if (parsed?.s !== sessionId || !phonePublic || phonePublic.length !== 65 || !proof || proof.length !== 32) return this.fail(session, deny);
    if (!(await verifyRedeemProof(session.token, sessionId, phonePublic, proof))) return this.fail(session, deny);
    // Re-check after the await: a concurrent request may have consumed or ended the session. Consume first, then compute.
    if (this.sessions.get(sessionId) !== session) return deny();
    this.sessions.delete(sessionId); clearTimeout(session.timer);
    try {
      const key = await deriveSessionKey(session.keys, phonePublic, session.token, sessionId, session.keys.publicKey, phonePublic);
      const sealed = await sealBundle(key, sessionId, session.bundle);
      this.reply(res, 200, { k: b64uEncode(session.keys.publicKey), n: b64uEncode(sealed.nonce), c: b64uEncode(sealed.ciphertext) }, origin);
    } catch { this.reply(res, 500, { e: "denied" }, origin); }
    session.bundle.fill(0); session.token.fill(0);
    this.options.onEvent?.(session.owner, { type: "redeemed" });
    this.closeListener(session.server);
  }

  private fail(session: Session, deny: () => void): void {
    session.failures++;
    deny();
    if (session.failures >= MAX_FAILED_ATTEMPTS) this.end(session.sessionId, { type: "too-many-attempts" });
  }
}

import { PairingError } from "./errors";

/**
 * Pairing key agreement (docs/design/mobile-qr-pairing.md "Protocol"): ephemeral ECDH P-256 on both sides, a token proof
 * (HMAC) to redeem, HKDF-SHA256 salted with the token, AES-256-GCM for the reply. WebCrypto only, so the same module runs in
 * Electron main, the renderer and an iOS WKWebView.
 */
export const PAIRING_CONTEXT = "geode-pair/1";
const utf8 = new TextEncoder();
const subtle = (): SubtleCrypto => { const s = globalThis.crypto?.subtle; if (!s) throw new PairingError("secure-storage-unavailable", "WebCrypto is unavailable"); return s; };
const buf = (bytes: Uint8Array): BufferSource => bytes as unknown as BufferSource;

export function b64uEncode(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Strict: only the base64url alphabet, no padding, canonical length. Returns null rather than throwing. */
export function b64uDecode(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4));
    const out = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return b64uEncode(out) === text ? out : null; // rejects non-canonical trailing bits
  } catch { return null; }
}
export function randomBytes(length: number): Uint8Array { return globalThis.crypto.getRandomValues(new Uint8Array(length)); }

export interface PairingKeyPair { privateKey: CryptoKey; publicKey: Uint8Array }
export async function generateKeyPair(): Promise<PairingKeyPair> {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)) };
}
async function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new PairingError("invalid-invitation", "Invalid public key");
  try { return await subtle().importKey("raw", buf(raw), { name: "ECDH", namedCurve: "P-256" }, false, []); }
  catch { throw new PairingError("invalid-invitation", "Invalid public key"); } // not on the curve
}

/** First 16 bytes of SHA-256 over the raw public key: what the QR pins. */
export async function keyFingerprint(publicKey: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(publicKey))).slice(0, 16);
}

const hmacKey = (token: Uint8Array, usage: KeyUsage) => subtle().importKey("raw", buf(token), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
const proofInput = (sessionId: string, phonePublic: Uint8Array) => utf8.encode(`${PAIRING_CONTEXT}\nredeem\n${sessionId}\n${b64uEncode(phonePublic)}`);
/** Proof of possession of the pairing token; the token itself is never sent. */
export async function redeemProof(token: Uint8Array, sessionId: string, phonePublic: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign("HMAC", await hmacKey(token, "sign"), buf(proofInput(sessionId, phonePublic))));
}
/** Constant-time verification (SubtleCrypto.verify). */
export async function verifyRedeemProof(token: Uint8Array, sessionId: string, phonePublic: Uint8Array, proof: Uint8Array): Promise<boolean> {
  return subtle().verify("HMAC", await hmacKey(token, "verify"), buf(proof), buf(proofInput(sessionId, phonePublic)));
}

/** Both sides call this with the *other* party's public key and arrive at the same AES-256-GCM key. */
export async function deriveSessionKey(own: PairingKeyPair, peerPublic: Uint8Array, token: Uint8Array, sessionId: string, desktopPublic: Uint8Array, phonePublic: Uint8Array): Promise<CryptoKey> {
  const secret = await subtle().deriveBits({ name: "ECDH", public: await importPublic(peerPublic) }, own.privateKey, 256);
  const ikm = await subtle().importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const info = utf8.encode(`${PAIRING_CONTEXT} key\n${sessionId}\n${b64uEncode(desktopPublic)}\n${b64uEncode(phonePublic)}`);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: buf(token), info: buf(info) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const aad = (sessionId: string) => utf8.encode(`${PAIRING_CONTEXT} bundle\n${sessionId}`);
export async function sealBundle(key: CryptoKey, sessionId: string, plaintext: Uint8Array): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const nonce = randomBytes(12);
  return { nonce, ciphertext: new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad(sessionId)) }, key, buf(plaintext))) };
}
export async function openBundle(key: CryptoKey, sessionId: string, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== 12) throw new PairingError("decrypt-failed", "The reply could not be decrypted.");
  try { return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad(sessionId)) }, key, buf(ciphertext))); }
  catch { throw new PairingError("decrypt-failed", "The reply could not be decrypted."); }
}

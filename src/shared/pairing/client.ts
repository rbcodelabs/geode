import { b64uDecode, b64uEncode, deriveSessionKey, generateKeyPair, keyFingerprint, openBundle, redeemProof } from "./crypto";
import { PairingError } from "./errors";
import { parseBundle, type PairingBundle, MAX_BUNDLE_BYTES } from "./bundle";
import { parseInvitation, parsePairingAddress, type PairingInvitation } from "./invitation";

export const PAIRING_PATH = "/geode-pair/v1/redeem";
export const MAX_REPLY_BYTES = 512 * 1024;
export interface RedeemOptions { fetch?: typeof fetch; timeoutMs?: number; nowMs?: number }

const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; };

/**
 * Phone side of the protocol. `invitation` is untrusted text (QR or paste). Callers must have checked secure storage first (the
 * token is spent on the first successful proof). Returns a validated bundle that has NOT been applied.
 */
export async function redeemInvitation(invitationText: string, options: RedeemOptions = {}): Promise<{ bundle: PairingBundle; address: string }> {
  const invitation: PairingInvitation = parseInvitation(invitationText, options.nowMs);
  const doFetch = options.fetch ?? fetch;
  const token = b64uDecode(invitation.token)!;
  const phone = await generateKeyPair();
  const proof = await redeemProof(token, invitation.sessionId, phone.publicKey);
  const body = JSON.stringify({ s: invitation.sessionId, k: b64uEncode(phone.publicKey), p: b64uEncode(proof) });
  let lastError: unknown;
  for (const address of invitation.addresses) {
    const { host, port } = parsePairingAddress(address);
    let response: Response;
    try {
      response = await doFetch(`http://${host}:${port}${PAIRING_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(options.timeoutMs ?? 8000), cache: "no-store", credentials: "omit", redirect: "error" });
    } catch (error) { lastError = error; continue; }
    if (response.status === 401) throw new PairingError("denied", "This code expired, was already used, or was cancelled. Show a new one on your computer.");
    if (response.status === 429) throw new PairingError("rate-limited", "Too many attempts. Show a new code on your computer.");
    if (!response.ok) { lastError = new Error(`status ${response.status}`); continue; }
    const declared = Number(response.headers.get("content-length") ?? "0"); if (declared > MAX_REPLY_BYTES) throw new PairingError("invalid-bundle", "The reply was too large.");
    const text = await response.text(); if (text.length > MAX_REPLY_BYTES) throw new PairingError("invalid-bundle", "The reply was too large.");
    let reply: unknown; try { reply = JSON.parse(text); } catch { throw new PairingError("decrypt-failed", "The reply could not be decrypted."); }
    const r = reply as { k?: unknown; n?: unknown; c?: unknown };
    const desktopPublic = b64uDecode(r?.k), nonce = b64uDecode(r?.n), ciphertext = b64uDecode(r?.c);
    if (!desktopPublic || !nonce || !ciphertext || ciphertext.length > MAX_BUNDLE_BYTES + 64) throw new PairingError("decrypt-failed", "The reply could not be decrypted.");
    // Pinning: only the desktop whose key the QR fingerprinted can proceed. Checked before any key is derived.
    if (!timingSafeEqual(await keyFingerprint(desktopPublic), b64uDecode(invitation.fingerprint)!)) throw new PairingError("identity-mismatch", "The reply wasn't from the computer that showed the code, so nothing was changed.");
    const key = await deriveSessionKey(phone, desktopPublic, token, invitation.sessionId, desktopPublic, phone.publicKey);
    const plaintext = await openBundle(key, invitation.sessionId, nonce, ciphertext);
    let json: unknown; try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)); } catch { throw new PairingError("invalid-bundle", "The pairing data from your computer was not valid, so nothing was changed."); }
    return { bundle: parseBundle(json), address };
  }
  throw new PairingError("unreachable", `Couldn't reach your computer${lastError instanceof Error && lastError.name === "TimeoutError" ? " (timed out)" : ""}. Check that both devices are on the same network and that Geode is still showing the code.`);
}

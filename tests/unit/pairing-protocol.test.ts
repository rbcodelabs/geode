import { describe, expect, it } from "vitest";
import { b64uDecode, b64uEncode, deriveSessionKey, generateKeyPair, keyFingerprint, openBundle, redeemProof, sealBundle, verifyRedeemProof, randomBytes } from "../../src/shared/pairing/crypto";
import { encodeInvitation, INVITATION_PREFIX, isPrivateAddress, parseInvitation, parsePairingAddress, type PairingInvitation } from "../../src/shared/pairing/invitation";
import { parseBundle, serializeBundle, type PairingBundle, PAIRING_PROVIDER_HUB } from "../../src/shared/pairing/bundle";
import { PairingError } from "../../src/shared/pairing/errors";
import { HUB_PROVIDER_ID } from "../../src/renderer/sync/hub-provider";

const NOW = 1_800_000_000_000;
const invitation = (over: Partial<PairingInvitation> = {}): PairingInvitation => ({ sessionId: b64uEncode(randomBytes(16)), token: b64uEncode(randomBytes(16)), fingerprint: b64uEncode(randomBytes(16)), expiresAt: NOW / 1000 + 180, addresses: ["192.168.1.5:51000"], ...over });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as PairingError).code; } return "none"; };
const bundle = (): PairingBundle => ({
  v: 1, provider: { id: PAIRING_PROVIDER_HUB, config: { url: "https://hub.example.ts.net/" } }, vault: { id: "123e4567-e89b-42d3-a456-426614174000", name: "Personal" },
  portable: { editor: { readableLineLength: true, foldHeading: false, showLineNumber: true, showRibbon: true, showStatusBar: true }, appearance: { theme: "dark", baseFontSize: 17, cssTheme: "" },
    hotkeys: { version: 1, overrides: {} }, dailyNotes: { enabled: true, folder: "Daily", format: "YYYY-MM-DD", template: "" } },
  credential: { scheme: "bearer", value: "s3cret-token" }, from: "Rick's Mac",
});

describe("pairing provider id", () => { it("matches the hub provider", () => expect(PAIRING_PROVIDER_HUB).toBe(HUB_PROVIDER_ID)); });

describe("invitation", () => {
  it("round-trips and stays small", () => {
    const original = invitation({ addresses: ["192.168.1.5:51000", "100.101.102.103:51000", "[fd00::1]:51000", "mac.local:51000"] });
    const text = encodeInvitation(original);
    expect(text.length).toBeLessThan(300);
    expect(parseInvitation(text, NOW)).toEqual(original);
  });
  it("rejects unknown versions, wrong prefixes, caps and malformed forms", () => {
    const good = encodeInvitation(invitation());
    expect(code(() => parseInvitation("geode-pair2." + good.slice(INVITATION_PREFIX.length), NOW))).toBe("unsupported-version");
    expect(code(() => parseInvitation("hello", NOW))).toBe("invalid-invitation");
    expect(code(() => parseInvitation(good + "A".repeat(600), NOW))).toBe("invalid-invitation");
    expect(code(() => parseInvitation(INVITATION_PREFIX + "!!!", NOW))).toBe("invalid-invitation");
    const enc = (raw: unknown) => INVITATION_PREFIX + b64uEncode(new TextEncoder().encode(JSON.stringify(raw)));
    const i = invitation();
    const fields = [i.sessionId, i.token, i.fingerprint, i.expiresAt, i.addresses];
    expect(code(() => parseInvitation(enc([2, ...fields]), NOW))).toBe("unsupported-version");
    expect(code(() => parseInvitation(enc([1, ...fields, "extra"]), NOW))).toBe("invalid-invitation");
    expect(code(() => parseInvitation(enc([1, "short", ...fields.slice(1)]), NOW))).toBe("invalid-invitation");
    expect(code(() => parseInvitation(enc([1, ...fields.slice(0, 4), []]), NOW))).toBe("invalid-invitation");
    expect(code(() => parseInvitation(enc([1, ...fields.slice(0, 4), Array(5).fill("10.0.0.1:1")]), NOW))).toBe("invalid-invitation");
    expect(code(() => parseInvitation(enc([1, ...fields.slice(0, 3), "soon", i.addresses]), NOW))).toBe("invalid-invitation");
    expect(code(() => parseInvitation(enc("not-an-array"), NOW))).toBe("invalid-invitation");
  });
  it("rejects expired invitations", () => expect(code(() => parseInvitation(encodeInvitation(invitation()), NOW + 181_000))).toBe("expired"));
  it("enforces the address policy", () => {
    for (const ok of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.1", "169.254.1.1", "100.64.0.1", "100.127.1.1", "127.0.0.1", "::1", "[fd12::1]", "fe80::1", "::ffff:192.168.1.1"]) expect(isPrivateAddress(ok), ok).toBe(true);
    for (const no of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2001:db8::1", "example.com", "1.2.3"]) expect(isPrivateAddress(no), no).toBe(false);
    expect(parsePairingAddress("my-mac.local:5000")).toEqual({ host: "my-mac.local", port: 5000 });
    expect(code(() => parsePairingAddress("example.com:5000"))).toBe("invalid-invitation");
    expect(code(() => parsePairingAddress("8.8.8.8:5000"))).toBe("invalid-invitation");
    expect(code(() => parsePairingAddress("192.168.1.1:0"))).toBe("invalid-invitation");
    expect(code(() => parsePairingAddress("192.168.1.1:99999"))).toBe("invalid-invitation");
    expect(code(() => parsePairingAddress("https://relay.example.com/x"))).toBe("relay-unsupported");
    expect(code(() => parsePairingAddress("192.168.1.1:80/../x"))).toBe("invalid-invitation");
    expect(code(() => parsePairingAddress("a".repeat(100) + ":80"))).toBe("invalid-invitation");
  });
  it("base64url decoding is strict", () => {
    expect(b64uDecode("AAAA")).toEqual(new Uint8Array(3));
    expect(b64uDecode("AA+/")).toBeNull(); expect(b64uDecode("AAAA=")).toBeNull(); expect(b64uDecode("A")).toBeNull(); expect(b64uDecode("AB")).toBeNull();
  });
});

describe("key agreement", () => {
  async function setup() {
    const desktop = await generateKeyPair(), phone = await generateKeyPair(), token = randomBytes(16), sid = b64uEncode(randomBytes(16));
    return { desktop, phone, token, sid };
  }
  it("both sides derive the same key; wrong token, wrong sid or tampering fails", async () => {
    const { desktop, phone, token, sid } = await setup();
    const dKey = await deriveSessionKey(desktop, phone.publicKey, token, sid, desktop.publicKey, phone.publicKey);
    const pKey = await deriveSessionKey(phone, desktop.publicKey, token, sid, desktop.publicKey, phone.publicKey);
    const sealed = await sealBundle(dKey, sid, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(await openBundle(pKey, sid, sealed.nonce, sealed.ciphertext))).toBe("hello");
    await expect(openBundle(pKey, b64uEncode(randomBytes(16)), sealed.nonce, sealed.ciphertext)).rejects.toMatchObject({ code: "decrypt-failed" });
    const tampered = sealed.ciphertext.slice(); tampered[0] ^= 1;
    await expect(openBundle(pKey, sid, sealed.nonce, tampered)).rejects.toMatchObject({ code: "decrypt-failed" });
    const wrongToken = await deriveSessionKey(phone, desktop.publicKey, randomBytes(16), sid, desktop.publicKey, phone.publicKey);
    await expect(openBundle(wrongToken, sid, sealed.nonce, sealed.ciphertext)).rejects.toMatchObject({ code: "decrypt-failed" });
    const eve = await generateKeyPair();
    const eveKey = await deriveSessionKey(eve, desktop.publicKey, token, sid, desktop.publicKey, eve.publicKey);
    await expect(openBundle(eveKey, sid, sealed.nonce, sealed.ciphertext)).rejects.toMatchObject({ code: "decrypt-failed" });
  });
  it("proofs bind token, session and phone key", async () => {
    const { phone, token, sid } = await setup(), other = await generateKeyPair();
    const proof = await redeemProof(token, sid, phone.publicKey);
    expect(await verifyRedeemProof(token, sid, phone.publicKey, proof)).toBe(true);
    expect(await verifyRedeemProof(randomBytes(16), sid, phone.publicKey, proof)).toBe(false);
    expect(await verifyRedeemProof(token, b64uEncode(randomBytes(16)), phone.publicKey, proof)).toBe(false);
    expect(await verifyRedeemProof(token, sid, other.publicKey, proof)).toBe(false);
  });
  it("fingerprints are 16 bytes and key-specific; off-curve points are refused", async () => {
    const a = await generateKeyPair(), b = await generateKeyPair();
    expect((await keyFingerprint(a.publicKey)).length).toBe(16);
    expect(b64uEncode(await keyFingerprint(a.publicKey))).not.toBe(b64uEncode(await keyFingerprint(b.publicKey)));
    const offCurve = new Uint8Array(65); offCurve[0] = 4; offCurve[64] = 1;
    await expect(deriveSessionKey(a, offCurve, randomBytes(16), "s", a.publicKey, b.publicKey)).rejects.toBeInstanceOf(PairingError);
  });
});

describe("bundle", () => {
  it("round-trips a full bundle", () => expect(parseBundle(JSON.parse(new TextDecoder().decode(serializeBundle(bundle()))))).toEqual(bundle()));
  it("allows no vault, no credential and empty portable", () => {
    const minimal = { ...bundle(), vault: null, credential: null, portable: {} };
    expect(parseBundle(JSON.parse(JSON.stringify(minimal)))).toEqual(minimal);
  });
  it("rejects unknown keys, wrong types and hostile values", () => {
    const base = () => JSON.parse(JSON.stringify(bundle()));
    const mutate = (fn: (b: any) => void) => { const b = base(); fn(b); return code(() => parseBundle(b)); };
    expect(mutate(b => { b.extra = 1; })).toBe("invalid-bundle");
    expect(mutate(b => { b.provider.extra = 1; })).toBe("invalid-bundle");
    expect(mutate(b => { b.v = 2; })).toBe("unsupported-version");
    expect(mutate(b => { b.provider.id = "google.drive"; })).toBe("unsupported-provider");
    expect(mutate(b => { b.provider.config.url = "http://hub.example.com"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.provider.config.url = "https://user:pw@hub.example.com"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.vault.id = "../../etc"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.vault.name = "bad\nname"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.vault.name = "x".repeat(129); })).toBe("invalid-bundle");
    expect(mutate(b => { b.portable.plugins = ["x"]; })).toBe("invalid-bundle");
    expect(mutate(b => { b.portable.dailyNotes.folder = "../outside"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.portable.editor.extra = true; })).toBe("invalid-bundle");
    expect(mutate(b => { b.portable.appearance.theme = "neon"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.credential.scheme = "basic"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.credential.value = ""; })).toBe("invalid-bundle");
    expect(mutate(b => { b.credential.key = "hub-token/evil"; })).toBe("invalid-bundle");
    expect(mutate(b => { b.from = "x".repeat(65); })).toBe("invalid-bundle");
    expect(code(() => parseBundle("string"))).toBe("invalid-bundle");
    expect(code(() => parseBundle(null))).toBe("invalid-bundle");
  });
  it("rejects prototype-polluting hotkey ids and oversize bundles", () => {
    const hotkeys = JSON.parse(`{"version":1,"overrides":{"__proto__":[]}}`);
    expect(code(() => parseBundle({ ...JSON.parse(JSON.stringify(bundle())), portable: { hotkeys } }))).toBe("invalid-bundle");
    const big = bundle(); big.portable.hotkeys = { version: 1, overrides: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`cmd:${i}-${"x".repeat(40)}`, [{ code: "KeyA", modifiers: [] }]])) } as never;
    expect(code(() => serializeBundle(big))).toBe("invalid-bundle");
  });
});

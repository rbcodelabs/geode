import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { MAX_FAILED_ATTEMPTS, MAX_SESSIONS_PER_WINDOW, PairingService, type PairingEvent } from "../../src/main/pairing-service";
import { redeemInvitation, PAIRING_PATH } from "../../src/shared/pairing/client";
import { parseInvitation } from "../../src/shared/pairing/invitation";
import { b64uEncode, generateKeyPair, randomBytes } from "../../src/shared/pairing/crypto";
import { PAIRING_PROVIDER_HUB, type PairingBundle } from "../../src/shared/pairing/bundle";

const bundle = (): PairingBundle => ({ v: 1, provider: { id: PAIRING_PROVIDER_HUB, config: { url: "https://hub.example.ts.net/" } }, vault: { id: "123e4567-e89b-42d3-a456-426614174000", name: "Personal" },
  portable: { editor: { readableLineLength: true, foldHeading: false, showLineNumber: false, showRibbon: true, showStatusBar: true } }, credential: { scheme: "bearer", value: "tok-123" }, from: "Test Mac" });

let clock = 1_800_000_000_000;
const events: Array<[string, PairingEvent["type"]]> = [];
const services: PairingService[] = [];
function make(over: Partial<ConstructorParameters<typeof PairingService>[0]> = {}) {
  const service = new PairingService({ now: () => clock, addresses: () => ["127.0.0.1"], bindHost: "127.0.0.1", onEvent: (owner, e) => events.push([owner, e.type]), ...over });
  services.push(service); return service;
}
afterEach(() => { for (const s of services.splice(0)) s.closeAll(); events.length = 0; clock = 1_800_000_000_000; });
const refused = (port: number) => new Promise<boolean>(resolve => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(false); }); s.once("error", () => resolve(true)); });
const post = (address: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(`http://${address}${PAIRING_PATH}`, { method: "POST", headers, body });
const portOf = (address: string) => Number(address.split(":").pop());

describe("PairingService", () => {
  it("delivers the bundle exactly once, then closes the listener", async () => {
    const service = make();
    const { invitation, addresses } = await service.start("w1", bundle());
    const result = await redeemInvitation(invitation, { nowMs: clock });
    expect(result.bundle).toEqual(bundle());
    expect(events).toEqual([["w1", "redeemed"]]);
    await expect(redeemInvitation(invitation, { nowMs: clock, timeoutMs: 1000 })).rejects.toMatchObject({ code: expect.stringMatching(/denied|unreachable/) });
    await new Promise(r => setTimeout(r, 50));
    expect(await refused(portOf(addresses[0]))).toBe(true);
    expect(service.liveCount).toBe(0);
  });
  it("keeps the token and bundle out of the QR text", async () => {
    const { invitation } = await make().start("w1", bundle());
    expect(Buffer.from(invitation.split(".")[1], "base64url").toString()).not.toMatch(/tok-123|Personal|hub\.example/);
    expect(invitation).not.toMatch(/tok-123/);
  });
  it("refuses a proof from someone who has not seen the QR; uniform 401 body; counts failures; dies after 5", async () => {
    const service = make(); const { invitation, addresses } = await service.start("w1", bundle());
    const parsed = parseInvitation(invitation, clock);
    const phone = await generateKeyPair();
    const bodies = new Set<string>();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const r = await post(addresses[0], JSON.stringify({ s: parsed.sessionId, k: b64uEncode(phone.publicKey), p: b64uEncode(randomBytes(32)) }));
      expect(r.status).toBe(401); bodies.add(await r.text());
    }
    expect(bodies.size).toBe(1);
    expect(events).toEqual([["w1", "too-many-attempts"]]);
    await new Promise(r => setTimeout(r, 50));
    expect(await refused(portOf(addresses[0]))).toBe(true);
    await expect(redeemInvitation(invitation, { nowMs: clock, timeoutMs: 1000 })).rejects.toMatchObject({ code: "unreachable" });
  });
  it("answers an unknown session id the same way as a bad proof", async () => {
    const { addresses } = await make().start("w1", bundle());
    const phone = await generateKeyPair();
    const r = await post(addresses[0], JSON.stringify({ s: b64uEncode(randomBytes(16)), k: b64uEncode(phone.publicKey), p: b64uEncode(randomBytes(32)) }));
    expect(r.status).toBe(401); expect(await r.json()).toEqual({ e: "denied" });
  });
  it("expires by the clock and by the timer", async () => {
    const service = make({ ttlMs: 60_000 }); const { invitation, addresses } = await service.start("w1", bundle());
    clock += 61_000; // handler path: clock past expiry before the timer fires
    await expect(redeemInvitation(invitation, { nowMs: clock - 3_600_000, timeoutMs: 1000 })).rejects.toMatchObject({ code: "denied" });
    expect(events.map(e => e[1])).toContain("expired");
    const second = make({ ttlMs: 30, now: Date.now }); const s = await second.start("w2", bundle());
    await new Promise(r => setTimeout(r, 120));
    expect(events.filter(e => e[0] === "w2").map(e => e[1])).toEqual(["expired"]);
    expect(await refused(portOf(s.addresses[0]))).toBe(true);
    void addresses;
  });
  it("cancel revokes immediately and starting again replaces the previous session", async () => {
    const service = make(); const first = await service.start("w1", bundle());
    const second = await service.start("w1", bundle());
    expect(events).toEqual([["w1", "cancelled"]]);
    await expect(redeemInvitation(first.invitation, { nowMs: clock, timeoutMs: 1000 })).rejects.toMatchObject({ code: "unreachable" });
    service.cancel("w1");
    expect(service.liveCount).toBe(0);
    await new Promise(r => setTimeout(r, 30));
    expect(await refused(portOf(second.addresses[0]))).toBe(true);
  });
  it("rate-limits session creation per window and recovers", async () => {
    const service = make();
    for (let i = 0; i < MAX_SESSIONS_PER_WINDOW; i++) await service.start("w1", bundle());
    await expect(service.start("w1", bundle())).rejects.toMatchObject({ code: "rate-limited" });
    clock += 10 * 60 * 1000 + 1;
    await expect(service.start("w1", bundle())).resolves.toBeTruthy();
  });
  it("fails when there is no private interface and rejects an invalid bundle before listening", async () => {
    await expect(make({ addresses: () => [] }).start("w1", bundle())).rejects.toMatchObject({ code: "no-network-interface" });
    const service = make();
    await expect(service.start("w1", { ...bundle(), provider: { id: PAIRING_PROVIDER_HUB, config: { url: "http://insecure.example.com" } } })).rejects.toMatchObject({ code: "invalid-bundle" });
    expect(service.liveCount).toBe(0);
  });
  it("enforces method, content-type, path and body-size limits", async () => {
    const { addresses } = await make().start("w1", bundle());
    expect((await fetch(`http://${addresses[0]}${PAIRING_PATH}`)).status).toBe(405);
    expect((await fetch(`http://${addresses[0]}/other`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await post(addresses[0], "{}", { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(addresses[0], "x".repeat(5000))).status).toBe(413);
    expect((await post(addresses[0], "not json")).status).toBe(401);
  });
  it("only echoes CORS for the app's origins and answers preflight", async () => {
    const { addresses } = await make().start("w1", bundle());
    const url = `http://${addresses[0]}${PAIRING_PATH}`;
    const ok = await fetch(url, { method: "OPTIONS", headers: { origin: "capacitor://localhost" } });
    expect(ok.status).toBe(204); expect(ok.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect((await fetch(url, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
    const denied = await fetch(url, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("a phone that pins a different desktop key refuses the reply", async () => {
    const service = make(); const { invitation } = await service.start("w1", bundle());
    const parsed = parseInvitation(invitation, clock);
    const forged = invitation.split(".")[0] + "." + Buffer.from(JSON.stringify([1, parsed.sessionId, parsed.token, b64uEncode(randomBytes(16)), parsed.expiresAt, parsed.addresses])).toString("base64url");
    await expect(redeemInvitation(forged, { nowMs: clock })).rejects.toMatchObject({ code: "identity-mismatch" });
  });
  it("closeAll drops every session", async () => {
    const service = make(); await service.start("a", bundle()); await service.start("b", bundle());
    service.closeAll(); expect(service.liveCount).toBe(0); expect(events.map(e => e[1])).toEqual(["cancelled", "cancelled"]);
  });
});

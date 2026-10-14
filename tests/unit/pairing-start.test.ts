import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { PairingService } from "../../src/main/pairing-service";
import { pairingDisplayName, startPairing } from "../../src/main/pairing-start";
import { redeemInvitation } from "../../src/shared/pairing/client";
import { PAIRING_PROVIDER_HUB, type PairingBundle } from "../../src/shared/pairing/bundle";

const bundle = (from = "attacker-chosen"): PairingBundle => ({ v: 1, provider: { id: PAIRING_PROVIDER_HUB, config: { url: "https://hub.example.ts.net/" } }, vault: null, portable: {}, credential: { scheme: "bearer", value: "t" }, from });

describe("startPairing (IPC handler core)", () => {
  it("overrides the renderer-supplied display name with the machine's", async () => {
    const service = new PairingService({ addresses: () => ["127.0.0.1"], bindHost: "127.0.0.1" });
    const reply = await startPairing(service, "1", bundle());
    expect(reply.ok).toBe(true); if (!reply.ok) return;
    const { bundle: got } = await redeemInvitation(reply.value.invitation);
    expect(got.from).toBe(pairingDisplayName()); expect(got.from).not.toBe("attacker-chosen");
    expect(pairingDisplayName()).toBe(os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64));
  });
  it("maps PairingError to a plain reply and never throws across IPC", async () => {
    const service = new PairingService({ addresses: () => [] });
    expect(await startPairing(service, "1", bundle())).toEqual({ ok: false, error: { code: "no-network-interface", message: expect.stringContaining("local network") } });
    const bad = { ...bundle(), provider: { id: PAIRING_PROVIDER_HUB, config: { url: "http://x.example.com" } } };
    expect(await startPairing(new PairingService({ addresses: () => ["127.0.0.1"], bindHost: "127.0.0.1" }), "1", bad)).toMatchObject({ ok: false, error: { code: "invalid-bundle" } });
    expect(await startPairing(new PairingService(), "1", null as never)).toMatchObject({ ok: false });
  });
});

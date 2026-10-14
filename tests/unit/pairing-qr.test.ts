import { describe, expect, it } from "vitest";
import { decodeQrPixels, matrixToRgba, qrMatrix } from "../../src/renderer/pairing/qr";
import { encodeInvitation, parseInvitation, MAX_INVITATION_CHARS } from "../../src/shared/pairing/invitation";
import { b64uEncode, randomBytes } from "../../src/shared/pairing/crypto";

const invitation = (addresses: string[]) => encodeInvitation({ sessionId: b64uEncode(randomBytes(16)), token: b64uEncode(randomBytes(16)), fingerprint: b64uEncode(randomBytes(16)), expiresAt: Math.floor(Date.now() / 1000) + 180, addresses });

describe("QR round trip", () => {
  for (const [label, addresses] of [["one address", ["192.168.1.20:52000"]], ["four addresses (worst case)", ["192.168.100.200:52000", "100.100.100.100:52000", "[fd00:1234:5678::1]:52000", "a-long-host-name.local:52000"]]] as const) {
    it(`encodes and decodes the invitation: ${label}`, () => {
      const text = invitation([...addresses]);
      expect(text.length).toBeLessThanOrEqual(MAX_INVITATION_CHARS);
      const matrix = qrMatrix(text);
      expect(matrix.length).toBeLessThanOrEqual(21 + 4 * 14); // stays under QR version 15 even in the worst case
      const { data, width, height } = matrixToRgba(matrix);
      const decoded = decodeQrPixels(data, width, height);
      expect(decoded).toBe(text);
      expect(parseInvitation(decoded!).addresses).toEqual([...addresses]);
    });
  }
  it("returns null for pixels with no code", () => expect(decodeQrPixels(new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100)).toBeNull());
  it("a decoded foreign QR is just untrusted text and is rejected by the invitation parser", () => {
    const { data, width, height } = matrixToRgba(qrMatrix("https://example.com/not-geode"));
    expect(() => parseInvitation(decodeQrPixels(data, width, height))).toThrow();
  });
});

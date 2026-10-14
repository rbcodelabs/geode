# ADR 0030 — Mobile pairing by QR code

Status: Proposed
Date: 2026-10-14
Extends [ADR 0015](0015-plugin-provided-vault-sync.md) (plugin-provided sync, guarded apply, portable configuration),
[ADR 0007](0007-mobile-runtime-and-platform-boundary.md) (mobile runtime; secrets live in Keychain) and
[ADR 0029](0029-https-websocket-hub-transport.md) (the HTTPS hub and its bearer token).
Design: [mobile-qr-pairing.md](../design/mobile-qr-pairing.md).

> Numbering note: this directory carries duplicated numbers; 0030 is the next unused one.

## Context

Setting up sync on a phone today means typing a hub URL, a long token and a vault choice on a touch keyboard, then
re-creating editor/appearance/hotkey/daily-note preferences by hand. The desktop already knows every one of those
values. A QR code shown on the desktop and scanned by the phone is the natural carrier, but a QR code is a photograph:
it is shoulder-surfable, screenshot-able and may sit in a chat or a camera roll for years. Anything printed in it must
be assumed public after the fact. The hub token is a full-access bearer credential (ADR 0029), so it must never be
printed.

## Decision

Add **pairing**: the desktop shows a QR code that is only an *invitation*; the phone redeems it over a pinned,
end-to-end encrypted channel and receives both the non-secret setup and the credential in the encrypted reply.

1. **The QR carries no secret that is useful after use and no configuration.** It holds a pairing-protocol version, a session
   id, a one-time pairing token, a 128-bit fingerprint of the desktop's ephemeral public key, an expiry and one to four
   desktop addresses (about 150 characters before encoding, so the code stays at a low QR version and scans from a laptop
   screen). Provider id, vault id, non-secret provider config, portable settings and the credential are all
   delivered by the encrypted reply, not printed. This is the "token + fetch" shape and is the only shape; there is no
   large-QR mode.
2. **Key agreement.** The desktop creates an ephemeral ECDH P-256 key pair per pairing session. The phone creates its
   own ephemeral pair, proves possession of the pairing token with `HMAC-SHA256(token, context ‖ session ‖ phone key)`
   (the token itself never crosses the network), and both sides derive an AES-256-GCM key with HKDF-SHA256 from the ECDH
   secret, salted with the token. The phone checks that the desktop's public key hashes to the fingerprint in the QR
   before using it, so an on-path attacker cannot substitute a key, and without the token cannot redeem. P-256 is chosen
   over X25519 because WebCrypto supports it in Electron, Node and every iOS WKWebView we target (X25519 needs iOS 17).
   No new cryptography dependency is added.
3. **Token lifecycle.** 3-minute lifetime, single use (consumed atomically before any secret is computed, whether the
   redeem then succeeds or not), at most 5 failed attempts per session before it dies, at most 3 sessions per 10 minutes,
   one live session per window, revoked immediately by Cancel, by closing the window or by quitting. Rationale in the
   design doc.
4. **Transport.** Version 1 ships **same-network direct**: while a session is live the desktop main process listens on
   an ephemeral port, accepts only private-range peers (RFC 1918, link-local, tailnet CGNAT, loopback, ULA), caps request
   bodies at 4 KiB and answers one JSON endpoint. Because LAN HTTP has no certificate, confidentiality and server
   authentication come from the pinned key agreement above, not from TLS. On iOS the one POST goes through native `CapacitorHttp`
   (as the Supported plugins downloads already do), so the WebView CSP stays `connect-src 'self' wss:`, there is no CORS preflight, and
   App Transport Security (`NSAllowsLocalNetworking`) is what limits cleartext to local addresses; the client additionally refuses any
   non-private address in the invitation. A **relay** (a rendezvous mailbox hosted by
   the user's own hub) is designed into the address field (`https://` entries) but not built in this change; see the design doc.
5. **What is delivered.** Active sync provider id, vault id (shared vault UUID) and display name, the non-secret provider
   config (for the hub provider: the HTTPS URL; never a token), the portable categories `editor`, `appearance`, `hotkeys`
   and `daily-notes`, and, inside the encrypted reply only, the provider credential. Plugin lists, plugin data and
   enablement, workspace state and local folder/ssh hub targets are never included. A desktop whose hub is a folder or
   ssh target, or whose provider has no phone-capable transport, cannot pair; the Settings tab says why.
6. **Phone side never trusts the payload.** Both the scanned invitation and the decrypted bundle pass strict schema
   validation (exact keys, size caps, unknown versions rejected, hub URL through `hubUrlProblem`, portable categories
   through the existing `portable-config` validator). Nothing is written until the user confirms a sheet that names the provider, hub
   host and vault and states that a credential will be stored in Keychain. Declining discards the reply from memory.
7. **Apply path.** Credentials go to `host.secrets.app` (Keychain via `GeodeKeychainStore`, ADR 0007), keyed like a typed-in
   token (`hubTokenKey`). The native Keychain bridge exists (`GeodeKeychainStore`); an older native build without it, or any browser host,
   has no `secrets.app`, and then the flow **fails closed before redeeming**: the token is not
   burned and nothing is stored in localStorage, device state or the vault. Provider config is saved through
   `HubSyncProvider.setConfig`. Portable settings are applied by `syncSafety.apply` with `namespace: "portable-config"`
   under a claimed owner lease and a preimage hash guard, i.e. the ADR 0015 guarded-mutation path; if the lease or guard
   fails the settings are skipped and reported, never forced. Pairing does **not** join the vault or approve a first
   sync: the user still previews and confirms the first-sync plan (ADR 0015), because a QR must not be able to authorize
   file deletion or overwrite.
8. **Scanning.** The camera scanner is `getUserMedia` in the WKWebView plus the pure-JS decoder `jsqr`, behind a
   `PairingScanner` interface. It needs two Info.plist keys (`NSCameraUsageDescription`, local-network usage) and no
   Capacitor plugin and no new native code. A **paste-code fallback** (the same invitation string, shown under the QR with Copy)
   is always available and is the path used when the camera is denied or absent and in automated tests. The
   desktop renders the QR with `qrcode-generator` (MIT, zero dependencies, about 20 KB). Both packages are lockfile-pinned,
   the decoder only ever sees untrusted pixels and produces a string that is then schema-validated.

## Alternatives rejected

- **Credentials in the QR (even encrypted with a short code).** Photographable and replayable; the whole point is that
  the code is not a secret after use.
- **Config in the QR, credential fetched.** Two delivery paths, a bigger code that scans worse, and an unauthenticated
  channel for the part that decides which vault the phone joins. One encrypted reply is simpler and stronger.
- **Camera plugin (`@capacitor-mlkit/barcode-scanning`, `@capacitor/barcode-scanner`).** Native ML Kit adds tens of MB
  and a Podfile dependency to every iOS build, and its availability is a Capacitor-major-version coupling. `getUserMedia`
  + `jsqr` adds ~130 KB of JS. The `PairingScanner` interface keeps a native scanner a drop-in replacement later.
- **Pairing code typed as digits + SPAKE2/PAKE.** Good UX without a camera but a new protocol with no vetted
  WebCrypto primitive; the paste fallback covers camera-less devices.
- **Plain HTTP on the LAN with the token under TLS-less "obfuscation".** No.
- **Per-device hub tokens now.** Would give true revocation but changes the hub server (ADR 0029 says one token per
  hub). Recorded as the follow-up that makes revocation complete.

## Consequences

- A new phone goes from install to a previewed first sync with one scan and one confirmation.
- Revocation is honest but partial: Cancel kills an unredeemed invitation instantly; a *delivered* hub token remains
  valid until the operator replaces the hub token file (ADR 0029). The design doc and the confirmation sheet say so.
- The desktop opens a listening socket for at most three minutes, only when the user asks, only for private peers.
  This is the main new attack surface; it is guarded by the token proof, rate limit, single use and body cap.
- iOS needs the user to grant Camera and Local Network permissions and the app needs an ATS local-networking
  exception for the LAN fetch. **Not verifiable without a device**; the paste path and the Node/browser harness
  cover everything else (see the design doc test plan).
- Desktop and phone must be on a shared network (or tailnet) in v1. Off-network pairing needs the relay (follow-up).
- Two small runtime dependencies are added (`qrcode-generator`, `jsqr`).

# Mobile QR pairing

Decision record: [ADR 0030](../adr/0030-mobile-qr-pairing.md). Builds on the HTTPS hub
([ADR 0029](../adr/0029-https-websocket-hub-transport.md), [app-hub-sync-provider.md](app-hub-sync-provider.md)), the
guarded sync apply and portable configuration ([ADR 0015](../adr/0015-plugin-provided-vault-sync.md),
[plugin-sync-api.md](../plugin-sync-api.md)) and the mobile secret boundary
([ADR 0007](../adr/0007-mobile-runtime-and-platform-boundary.md)).

## Goal and non-goals

One scan on the phone replaces typing the hub URL and token, choosing the vault, and re-entering portable preferences.

Non-goals: pairing does not join the vault, approve a first sync, install plugins, move plugin data, or give the phone
any access the desktop does not already hold. It is not a login system and creates no Geode account.

## Roles

- **Desktop** (Electron): has the active provider, its config, the credential in `safeStorage`, and the portable settings.
  It runs the pairing session. Settings > Sync > "Pair mobile device".
- **Phone** (Capacitor/iOS, same renderer): scans or pastes the invitation, redeems, confirms, applies.

Only providers that declare a phone-capable pairing adapter can pair. Today that is one: the built-in hub provider
(`geode.hub`) with an `http` target. Folder and ssh targets name paths and hosts that mean nothing on a phone, and other
providers (for example a Drive provider) have no mobile transport, so the tab explains "this hub type cannot be used on a phone"
instead of showing a code.

## Payloads

### Invitation (what the QR holds)

Printed as `geode-pair1.` + base64url(JSON array), where the array is
`[1, sessionId, token, keyFingerprint, expiresAtUnixSeconds, addresses]`:

| Field | Form | Notes |
|---|---|---|
| version | `1` | Reject any other value; the prefix carries the same major so a v2 invitation is rejected before JSON parsing. |
| sessionId | 16 random bytes, base64url (22 chars) | Public handle. |
| token | 16 random bytes, base64url (22 chars) | The pairing secret. 128 bits; never sent on the wire, only used for an HMAC and as an HKDF salt. |
| keyFingerprint | first 16 bytes of SHA-256 of the desktop ephemeral public key (raw 65-byte point), base64url | Pins the desktop key. |
| expiresAt | integer seconds | Informational for the phone UI and an early reject; the desktop clock is authoritative. |
| addresses | 1-4 strings | `host:port` (cleartext HTTP, **only** private-range literals or `.local`/tailnet names) or `https://...` (reserved for the relay; rejected in v1 builds that have no relay client). |

Hard caps enforced before parsing: the whole string at most 512 characters, addresses at most 4 of at most 80 characters.
Typical length is ~190 characters, which is a QR version 9-10 at error-correction level L and scans reliably from a laptop
screen; the cap keeps it below version 14 even in the worst case.

**Size analysis and fallback.** A QR symbol holds at most 2,953 bytes (version 40-L) and real-world camera scans degrade
quickly above ~300 bytes. The portable settings alone may reach 1 MiB per category (hotkey overrides), the hub URL up to
2 KiB, so the configuration cannot be assumed to fit. Therefore the QR never carries configuration at all: it carries the
handle to fetch it. There is no inline mode to fall back *from*; "token + fetch" is the design.

### Bundle (what the encrypted reply holds)

```jsonc
{
  "v": 1,
  "provider": { "id": "geode.hub", "config": { "url": "https://my-box.tailnet.ts.net" } },
  "vault":    { "id": "<shared vault uuid>", "name": "Personal" },   // or null when no vault is bound yet
  "portable": {                                                      // each key optional; validated by portable-config
    "editor": {...}, "appearance": {...}, "hotkeys": {...}, "dailyNotes": {...}
  },
  "credential": { "scheme": "bearer", "value": "<hub token>" },      // null when the desktop has none saved
  "from": "<desktop display name, <= 64 chars>"
}
```

Rules: unknown top-level or nested keys are rejected (exact-key objects, as `portable-config` already does); plaintext at
most 256 KiB; `provider.id` must be one the phone has an adapter for; `provider.config.url` must pass `hubUrlProblem`
(HTTPS/WSS only, no credentials); `vault.id` is a UUID; `vault.name` at most 128 characters, control characters
rejected; each portable category passes the same validator that guards sync (`validatePortableConfig`, the existing
`validateDocument`, exported). The storage key for the credential is **derived on the phone** (`hubTokenKey(url)`), never
taken from the payload. Versioning: `v` is a major only; a reader rejects higher majors and may ignore nothing, since
unknown keys are rejected. Additive change therefore means a new major and a new invitation prefix, which is the intent:
an old phone must refuse rather than half-apply.

## Protocol

All values base64url. Context string `C = "geode-pair/1"`.

```
Desktop (user clicks Pair)                           Phone (scan / paste)
 gen ECDH P-256 pair (dPriv, dPub)
 sid, tok = random(16) each
 fp = SHA-256(dPub)[0:16]
 listen on ephemeral port (private peers only)
 show QR(invitation)  ------------ optical ------->  parse + validate invitation (caps, version, expiry, address policy)
                                                     secure storage available?  no -> STOP (fail closed, token not spent)
                                                     gen ECDH pair (pPriv, pPub)
                                                     proof = HMAC-SHA256(tok, C|"\nredeem\n"|sid|"\n"|pPub)
        <-------- POST /geode-pair/v1/redeem {s: sid, k: pPub, p: proof} ---------
 find session by sid; check unexpired, unconsumed, attempts<5
 verify proof (constant time)  -> else count a failure, reply 401 "denied" (same body for every failure)
 mark CONSUMED (before computing anything secret)
 secret = ECDH(dPriv, pPub)
 key = HKDF-SHA256(ikm=secret, salt=tok, info=C|" key\n"|sid|"\n"|dPub|"\n"|pPub, 32 bytes)
 ct = AES-256-GCM(key, nonce12, bundleJSON, aad=C|" bundle\n"|sid)
        ----------- 200 {k: dPub, n: nonce, c: ct} ------------>
                                                     SHA-256(dPub)[0:16] == fp ?  no -> STOP
                                                     derive key, decrypt (GCM tag failure -> STOP)
                                                     validate bundle (strict) ; show confirmation sheet
                                                     user confirms -> apply (below); declines -> drop reply
 UI: "Paired with a device" (redeem observed); close listener, zero session
```

Why this is sound: the phone talks to *whoever* holds `dPriv` because it pins the fingerprint from the QR, so an
on-path attacker (LAN, hostile Wi-Fi) cannot read or substitute the reply. Only a party that saw the QR can produce
`proof`, because the token is never transmitted; seeing the HMAC on the wire does not reveal a 128-bit token. A party that
photographs the QR *after* the real phone redeemed finds the session consumed. A party that photographs it *before* the user scans can
win the race, which is the inherent limit of any bearer QR: the mitigations are the 3-minute lifetime, the on-screen
countdown, and the desktop showing when redemption happened so the user notices if their own phone then fails.
Forward secrecy: both keys are ephemeral, so a later desktop compromise does not decrypt a recorded exchange.

### Expiry, single use, rate limit, revocation

| Control | Value | Reason |
|---|---|---|
| Lifetime | 180 s from display | Long enough to open the phone app and scan; short enough that an abandoned screen is not a standing credential. The user can generate a new code (shown with a visible countdown; at 0 the QR is replaced by "Expired"). |
| Single use | consumed on the first request carrying a valid proof, before the reply is built | A failed decrypt/validate/confirm on the phone costs the user one fresh code, never a retry window. |
| Failed attempts | 5 per session, then the session is destroyed | The proof is a 128-bit MAC so guessing is infeasible; the cap bounds CPU/log noise and any oracle. |
| Session creation | 3 per rolling 10 minutes per app run | Stops a runaway UI loop or a scripted abuse from opening listeners repeatedly. |
| Concurrency | one live session per desktop window | Starting a new one revokes the previous. |
| Revocation | Cancel button, window close, vault switch, app quit, provider config change | Listener closed and session secrets dropped synchronously. |
| Peer policy | RFC 1918, 169.254/16, 100.64/10 (tailnet), 127/8, `::1`, `fc00::/7`, `fe80::/10` | A public address reaching the port is dropped without a response. |
| Body | 4 KiB max, `Content-Type: application/json`, POST only, 5 s read timeout | Small parser surface. |
| CORS | echo `Origin` only for `capacitor://localhost`, `ionic://localhost`, `http://localhost[:port]`; handle `OPTIONS` | The WKWebView origin; a random website cannot read the reply (and could not decrypt it anyway). |

**What revocation does *not* cover.** After a successful redeem the phone holds the hub token. ADR 0029's hub has one
token per hub, so removing one phone means replacing the hub token file and restarting `geode-wiki sync serve`, which
disconnects every device. The confirmation sheet and the Settings tab state this. Per-device hub tokens (a hub-server
change) are the follow-up that would let "Unpair this phone" be real; they fit the protocol unchanged because only the
`credential` the desktop mints changes.

### Same-LAN direct (v1) versus relay (designed, not built)

- **Direct.** Works when the phone can open a TCP connection to the desktop: same Wi-Fi, or both on a tailnet (the
  tailnet address is included automatically when present). No third party sees anything. Fails on guest/isolated Wi-Fi
  (client isolation), VPN split tunnels and when macOS firewall blocks the incoming connection. iOS additionally shows
  a one-time Local Network permission prompt.
- **Relay.** For off-network pairing the user's own hub (`geode-wiki sync serve --http`, ADR 0029) would gain a
  `/geode-pair/v1/mailbox/<sid>` rendezvous: the desktop connects outbound and holds the encrypted reply slot open, the
  phone POSTs the same `redeem` message there. The relay sees only the session id, the phone public key, the proof and
  the ciphertext; it cannot decrypt (no `dPriv`, no token) and cannot redeem (no token). Auth to the relay is the hub token
  the desktop already has, so a stranger cannot use it as a free mailbox. The invitation already admits `https://`
  addresses for this; v1 clients reject them with "update the app" so a future invitation never silently downgrades. Not
  implemented here because it is a hub-server change with its own abuse analysis.
- **Neither reachable / camera unavailable.** The phone offers manual setup (the existing hub URL + token fields) and the
  paste box. Paste only helps when the network path exists; a missing path is reported as such with its likely causes.

## Desktop behaviour

- Settings > Sync > **Pair mobile device** card. Shown whenever an HTTPS hub is configured *and* a token is saved. Button
  **Show pairing code** builds the bundle from live state (provider config, bound vault from the sync binding, portable
  projection through `projectPortableConfig` with the default sync scope, credential from `secrets.app`), asks the main
  process to open a session, and renders QR + countdown + Cancel + the paste string (collapsed, with Copy).
- The bundle crosses renderer to main over IPC in memory only and is never logged or written to disk. Main keeps it
  only inside the session object and drops it on redeem/expiry/cancel.
- No credential means the code is still useful for settings, but the card warns "no hub token is saved on this device; the
  phone will ask for it" and the bundle's `credential` is `null`.
- Failure to bind (no private interface, port in use) shows "Could not start pairing" with the cause; nothing is left
  listening.

## Phone behaviour

Settings > Sync > **Set up from desktop**: Scan (camera) or Paste code. Steps and their failure handling:

| Step | Failure | Result |
|---|---|---|
| Parse invitation | Wrong prefix/version, over cap, malformed, expired | "This isn't a valid, current Geode pairing code." Nothing sent. |
| Secure storage check | `secrets.app` unavailable (browser, or native Keychain absent) | Refuse **before redeeming**: "This device can't store the hub token securely." Token not spent. |
| Connect | No address reachable in 8 s each | "Couldn't reach your computer" + checklist (same network, firewall, Local Network permission). Token still valid until it expires. |
| Redeem | 401 `denied` | "Code expired, already used, or cancelled. Show a new one on your computer." |
| Verify/decrypt | fingerprint or GCM failure | "The reply wasn't from the computer that showed the code." Discard. |
| Validate bundle | schema/size/URL/portable validation error | Refuse, name the field class (not the content), nothing stored. |
| Confirm | user declines | Reply discarded; nothing stored; the desktop code is already spent. |
| Apply | Keychain write error | Stop; do not save config; report. |
| Apply | owner lease unavailable or preimage hash mismatch for a portable category | That category is skipped and listed ("settings changed while pairing"); credential and config are kept. |

**Confirmation sheet** (nothing is written before it): provider name, hub host, vault name and id prefix, which settings
categories will be applied, "A hub token will be saved in this device's Keychain", and "Setup does not start syncing;
you'll review the first sync plan next." Buttons: Cancel, Set up.

**Apply order**: (1) `secrets.app.set(hubTokenKey(url), token)` -> (2) `HubSyncProvider.setConfig({http url})` ->
(3) portable categories via `syncSafety.apply({namespace:"portable-config", expectedHash, kind:"write"})` under
`claimOwner()` (the same guarded path sync uses, so recovery receipts, symlink refusal and preimage guards apply),
then the normal post-apply refresh -> (4) Sync settings opens on "Shared vault setup" with a prompt to join the named
vault. Order matters: the credential is stored last-secure-first only after confirmation, and a failure at (1) leaves no
partial config. If steps 2-3 fail after 1 succeeds the token is removed again (best effort) so a failed pairing does not
leave an orphan credential.

## Threat model

| Threat | Mitigation | Residual |
|---|---|---|
| Photo/screenshot of QR later | Token single-use and 3-min expiry; QR holds no credential/config | Race within the 3-minute window |
| Shoulder-surf during window | Same; desktop shows redeem event | Attacker redeems first; user's phone then fails visibly |
| LAN eavesdropper | Reply is AES-GCM under ECDH key; token never sent | Metadata (that pairing happened, sizes) |
| LAN MITM / rogue AP | Desktop key pinned by fingerprint in the QR | None for a QR scanned in person |
| Port scanner / hostile peer | Private-peer filter, proof required, 5-strike session kill, 4 KiB cap, uniform 401 | Resource use while open (<= 3 min) |
| Replay of a captured redeem | Single use; captured reply useless without phone private key | None |
| Malicious QR (attacker's desktop) | Phone validates strictly, shows host + vault, requires confirmation, never auto-joins/syncs; the attacker would have to give the phone *their* hub, whose token they hold anyway | User confirming a hostile hub URL: the confirmation sheet names the host |
| Malicious bundle fields (path traversal in daily-note folder, prototype keys, huge hotkeys) | Existing portable-config validators, exact-key objects, 256 KiB cap | - |
| Credential at rest on phone | Keychain only (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), fail closed otherwise | Jailbreak/forensics out of scope |
| Delivered token abuse after phone loss | Only hub-token rotation revokes it | Documented limitation; per-device tokens are the fix |
| Malware on desktop | Out of scope (already holds the token) | - |

## Test plan

Automated (this change):

- **Unit, protocol** (`tests/unit/pairing-*.test.ts`): invitation encode/parse round-trip; every cap and malformed form
  rejected; unknown version rejected; crypto round-trip desktop<->phone in-process; wrong token -> proof fails; wrong
  fingerprint -> phone refuses; tampered ciphertext -> GCM failure; second redeem refused; expiry via fake clock; 5
  failures kill the session; session-creation rate limit; revoke drops secrets.
- **Unit, server** (real `http` listener on 127.0.0.1): happy path returns a decryptable reply; uniform 401 body for
  bad proof/expired/unknown/consumed; 4 KiB body cap; non-POST rejected; CORS allow-list; public-peer rejection
  (address-policy function tested directly); listener closed after redeem/expiry/cancel (connection refused).
- **Unit, bundle**: strict schema (extra keys, wrong types, bad URL, bad portable category, oversize); credential key is derived
  not supplied.
- **Unit, apply** (fakes for secrets, provider, syncSafety): secure-storage-absent fails closed and never calls
  redeem; confirm-decline writes nothing; guard mismatch skips only that category; Keychain failure leaves no config;
  rollback removes the token on later failure.
- **QR render/scan**: encode the invitation with `qrcode-generator`, decode it with `jsqr` from the rendered matrix, and assert
  string equality (a real round trip, no camera).
- **Mobile harness (Playwright, `tests/mobile/pairing.spec.ts`, iPhone 13 project)**: the real phone panel, flow and apply path against the
  real `PairingService` (relayed through Node because the harness page is `file://`; CSP bypassed as in `supported-plugins.spec.ts`
  because iOS uses native `CapacitorHttp`): paste -> confirmation sheet shows hub host, vault and categories and *nothing is stored
  before confirming*; accept -> token only in the fake Keychain (not in web storage), config saved, portable categories applied through
  `syncSafety.apply({namespace:"portable-config", expectedHash})`, desktop session consumed, replay refused; decline stores nothing;
  no Keychain -> refused with the desktop session still live (token not spent); foreign/malformed code -> rejected with no network
  request. The real **desktop card** also runs there (the IPC hop replaced by exposed functions): QR + countdown + paste string appear,
  the code contains neither token nor hub URL, redeeming delivers the bundle and the card reports "Paired", Cancel revokes at once.
- **Typecheck + unit** cover the preload/`ipcMain` seam only through `startPairing` (display name forced to the machine's, errors mapped to
  plain replies); the Electron IPC registration itself is not exercised end to end (see below).

Not verified in this environment (reported as NOT VERIFIED; the dev box has no Electron binary, Xvfb or GTK libraries):
an Electron end-to-end run of the Settings card over real IPC, the iOS camera permission and real `getUserMedia` scan, the iOS Local
Network prompt and ATS behaviour for a cleartext LAN fetch from the WKWebView, a real Wi-Fi/tailnet path, and the native
Keychain write in this flow (the Keychain plugin exists; this flow's use of it is exercised only through the host
interface).

## Open items and assumptions

- 3 minutes chosen within the 2-5 minute range given; adjustable constant `PAIRING_TTL_MS`.
- Cleartext LAN HTTP relies on ATS `NSAllowsLocalNetworking`; if a device rejects it the user falls back to manual entry
  and the relay follow-up becomes the fix.
- The phone cannot show a desktop-side "approve this device" step in v1; the redeem notice on the desktop is the
  after-the-fact signal.

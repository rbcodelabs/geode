# macOS WebAuthn provisioning and verification

PR #246 initializes Electron's Touch ID / Secure Enclave authenticator after
the app is ready. Its keychain group is
`6M8F464WCQ.com.rbcodelabs.geode.webauthn`, matching Geode's current Developer ID
team. This initialization is only one prerequisite, not proof of passkey support.

## Capability boundary

Electron's `touchID` authenticator creates device-bound credentials. They are
not synced through iCloud Keychain and cannot use passkeys previously saved in
Safari or another browser. Credentials are isolated by Electron session, so
registration and authentication must use the same `persist:webviewer` partition.
This work does not implement iCloud Passwords access or a third-party password
manager integration.

## Packaging prerequisite

The standard release entitlements currently grant JIT only. Developer ID signing
and notarization do not grant the WebAuthn keychain group. Before changing release
packaging, obtain a macOS Developer ID provisioning profile that authorizes:

- Team `6M8F464WCQ`, bundle ID `com.rbcodelabs.geode`, and full application
  identifier `6M8F464WCQ.com.rbcodelabs.geode`.
- Keychain group `6M8F464WCQ.com.rbcodelabs.geode.webauthn` (or an applicable
  wildcard grant).
- The Developer ID Application certificate used to sign the build.

Inspect a supplied profile with `security cms -D -i <profile>`, including its
expiration, application identifier, team, certificate, and keychain entitlement.
Keep profiles and signing credentials out of git. The app's signed entitlements
and embedded `Contents/embedded.provisionprofile` must agree with the profile.
Adding a restricted keychain entitlement without matching provisioning can make
macOS refuse to launch the app. Do not add it to the normal release configuration
until a separately packaged test build has passed the checks below.

## Native acceptance checks

Use a separate signed test app, throwaway vault and user-data directory on a Mac
with Secure Enclave and configured Touch ID. Preserve the installed release.

1. Verify the app's signature using `codesign --verify --deep --strict <app>`;
   inspect team and entitlements with `codesign -dv --verbose=4 <app>` and
   `codesign -d --entitlements :- <app>`. Decode its embedded profile and confirm
   the WebAuthn group is authorized.
2. Launch the test app successfully before attempting a credential ceremony.
3. In a secure test relying party opened in Web Viewer, evaluate
   `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` and
   record the result. A true result is a capability check, not authentication.
4. Register a new test credential with platform attachment, resident-key and
   user-verification requirements. Complete Touch ID and verify that the relying
   party accepts the registration response.
5. Authenticate in the same partition and verify the assertion at the relying
   party. Restart the app using the same test user data and repeat authentication
   to test persistence.
6. Cancel a ceremony and confirm the page receives a rejection and can retry.
   Record separate results for embedded Web Viewer and a top-level test window.

Virtual-authenticator tests and unsigned Electron launches do not verify these
native checks. Until a provisioned build completes them, native passkey support
remains unverified. No release entitlement is changed by this PR.

## References

- [Electron app.configureWebAuthn](https://www.electronjs.org/docs/latest/api/app#appconfigurewebauthnoptions)
- [Apple TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)

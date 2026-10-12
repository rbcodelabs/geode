/**
 * Wire constants of the hub store protocol ("geode-store-rpc"; framing described in src/sync-node/rpc-framing.ts).
 * Node-free so that the stdio/ssh transport, the WebSocket server and the browser-safe client agree on one definition.
 */
export const PROTOCOL_NAME = "geode-store-rpc";
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;

/**
 * WebSocket sub-protocols of the HTTPS hub transport. Browsers (WKWebView included) cannot set an Authorization header on a
 * WebSocket, so the token travels as `bearer.<base64url(utf8 token)>` in Sec-WebSocket-Protocol next to the real
 * sub-protocol; the server never echoes it back and never accepts a token in the URL (URLs end up in logs and history).
 */
export const WS_SUBPROTOCOL = "geode-store.v1";
export const WS_TOKEN_PREFIX = "bearer.";

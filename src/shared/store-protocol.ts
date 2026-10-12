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

/**
 * Client-side tuning shared by every transport's session (stdio RpcStoreSession and the browser-safe HttpStoreSession):
 * chunking, batching and pipelining windows. Wire-visible only through request sizes, never through the protocol itself.
 */
export const CLIENT_CHUNK_BYTES = MAX_FRAME_BYTES;
export const SCAN_PAGE = 200;
/** Records per appendRecords request, and the JSON size past which a batch is split (the header line is capped at 16 MiB). */
export const APPEND_BATCH = 64;
export const APPEND_BATCH_JSON_BYTES = 2 * 1024 * 1024;
/** Upload concurrency against a server that does not advertise `maxUploads` (it allows 4 open uploads). */
export const LEGACY_UPLOADS = 4;
export const MAX_UPLOAD_CONCURRENCY = 16;
/** Chunk requests of one blob kept in flight, and how many whole-blob reads the engine may overlap. */
export const READ_WINDOW = 4;
export const READ_CONCURRENCY = 12;

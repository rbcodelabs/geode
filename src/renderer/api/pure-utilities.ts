/** Convert every byte in an ArrayBuffer to standard padded base64. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const data = new Uint8Array(buffer);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode standard base64 into its original bytes. */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    data[index] = binary.charCodeAt(index);
  }
  return data.buffer;
}

/** Convert every byte in an ArrayBuffer to lowercase, unprefixed hex. */
export function arrayBufferToHex(data: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(data)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Decode an unprefixed hexadecimal byte string into an ArrayBuffer. */
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const data = new Uint8Array(hex.length / 2);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return data.buffer;
}

/**
 * Parse linktext without its surrounding wikilink brackets into the file path
 * and its optional heading/block subpath. The returned subpath retains `#`.
 */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const subpathStart = linktext.indexOf("#");
  if (subpathStart === -1) return { path: linktext, subpath: "" };
  return {
    path: linktext.slice(0, subpathStart),
    subpath: linktext.slice(subpathStart),
  };
}

/** Return the file path portion of linktext without a heading/block subpath. */
export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

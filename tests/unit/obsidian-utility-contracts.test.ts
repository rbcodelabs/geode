import { describe, expect, it } from "vitest";
import * as ObsidianApi from "../../src/renderer/api/obsidian";
import * as PluginManagerModule from "../../src/renderer/plugin-manager";

function bytes(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)];
}

describe("Obsidian ArrayBuffer utility contracts", () => {
  it("exports the utilities from the compatibility module used by require('obsidian')", () => {
    expect(ObsidianApi.arrayBufferToBase64).toBeTypeOf("function");
    expect(ObsidianApi.base64ToArrayBuffer).toBeTypeOf("function");
    expect(ObsidianApi.arrayBufferToHex).toBeTypeOf("function");
    expect(ObsidianApi.hexToArrayBuffer).toBeTypeOf("function");
  });

  it("encodes and decodes base64 without treating bytes as text", () => {
    const original = Uint8Array.from([0, 255, 128, 65, 66]).buffer;
    const encoded = ObsidianApi.arrayBufferToBase64(original);

    expect(encoded).toBe("AP+AQUI=");
    expect(bytes(ObsidianApi.base64ToArrayBuffer(encoded))).toEqual([
      0, 255, 128, 65, 66,
    ]);
  });

  it("encodes lowercase two-digit hex and decodes it losslessly", () => {
    const original = Uint8Array.from([0, 1, 15, 16, 127, 128, 255]).buffer;
    const encoded = ObsidianApi.arrayBufferToHex(original);

    expect(encoded).toBe("00010f107f80ff");
    expect(bytes(ObsidianApi.hexToArrayBuffer(encoded))).toEqual([
      0, 1, 15, 16, 127, 128, 255,
    ]);
  });

  it("round-trips empty buffers", () => {
    const empty = new ArrayBuffer(0);
    expect(ObsidianApi.arrayBufferToBase64(empty)).toBe("");
    expect(ObsidianApi.base64ToArrayBuffer("").byteLength).toBe(0);
    expect(ObsidianApi.arrayBufferToHex(empty)).toBe("");
    expect(ObsidianApi.hexToArrayBuffer("").byteLength).toBe(0);
  });
});

describe("Obsidian wikilink utility contracts", () => {
  it("exports the utilities from the compatibility module used by require('obsidian')", () => {
    expect(ObsidianApi.parseLinktext).toBeTypeOf("function");
    expect(ObsidianApi.getLinkpath).toBeTypeOf("function");
  });

  it("splits a wikilink target into its filepath and heading or block subpath", () => {
    expect(ObsidianApi.parseLinktext("Folder/Note.md#Heading")).toEqual({
      path: "Folder/Note.md",
      subpath: "#Heading",
    });
    expect(ObsidianApi.parseLinktext("Note#^block-id")).toEqual({
      path: "Note",
      subpath: "#^block-id",
    });
  });

  it("returns an empty subpath for a file-only link and supports same-file subpaths", () => {
    expect(ObsidianApi.parseLinktext("Folder/Note")).toEqual({
      path: "Folder/Note",
      subpath: "",
    });
    expect(ObsidianApi.parseLinktext("#Local heading")).toEqual({
      path: "",
      subpath: "#Local heading",
    });
  });

  it("returns only the file path portion from linktext", () => {
    expect(ObsidianApi.getLinkpath("Folder/Note.md#Heading")).toBe(
      "Folder/Note.md",
    );
    expect(ObsidianApi.getLinkpath("#Local heading")).toBe("");
    expect(ObsidianApi.getLinkpath("Plain note")).toBe("Plain note");
  });
});

describe("plugin CommonJS compatibility module", () => {
  it("makes all six utilities available through require('obsidian')", () => {
    expect(PluginManagerModule.instantiatePluginClass).toBeTypeOf("function");
    const PluginClass = PluginManagerModule.instantiatePluginClass(
      `
        const obsidian = require("obsidian");
        module.exports = class UtilityProbe extends obsidian.Plugin {
          static results = {
            base64: obsidian.arrayBufferToBase64(Uint8Array.from([65, 66]).buffer),
            bytes: Array.from(new Uint8Array(obsidian.base64ToArrayBuffer("QUI="))),
            hex: obsidian.arrayBufferToHex(Uint8Array.from([15, 255]).buffer),
            hexBytes: Array.from(new Uint8Array(obsidian.hexToArrayBuffer("0fff"))),
            parsed: obsidian.parseLinktext("Note#Heading"),
            path: obsidian.getLinkpath("Note#Heading")
          };
        };
      `,
      "utility-probe",
    ) as unknown as { results: unknown };

    expect(PluginClass.results).toEqual({
      base64: "QUI=",
      bytes: [65, 66],
      hex: "0fff",
      hexBytes: [15, 255],
      parsed: { path: "Note", subpath: "#Heading" },
      path: "Note",
    });
  });
});

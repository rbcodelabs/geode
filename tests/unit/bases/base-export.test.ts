import { describe, expect, it } from "vitest";
import type { BaseDefinition } from "../../../src/renderer/bases/base-file";
import { buildExportMatrix, matrixToCsv, matrixToTsv } from "../../../src/renderer/bases/base-export";
import type { QueryRow } from "../../../src/renderer/bases/query-engine";
import { str, num, nullValue } from "../../../src/renderer/bases/value";
import type { TFile } from "../../../src/renderer/types";

function fakeFile(basename: string): TFile {
  return { basename, name: `${basename}.md`, path: `${basename}.md`, extension: "md" } as TFile;
}

function row(basename: string, props: Record<string, ReturnType<typeof str>>): QueryRow {
  return { file: fakeFile(basename), properties: props, formulas: {} } as unknown as QueryRow;
}

const def: BaseDefinition = {
  filters: undefined,
  formulas: {},
  properties: { "note.status": { displayName: "Status" } },
  summaries: {},
  views: [],
};

describe("buildExportMatrix", () => {
  it("emits a header row of column display names, then one row per result using display values", () => {
    const rows = [
      row("Alpha", { "file.name": str("Alpha.md"), "note.status": str("Todo"), "note.priority": num(1) }),
      row("Beta", { "file.name": str("Beta.md"), "note.status": str("Done"), "note.priority": num(2) }),
    ];
    const matrix = buildExportMatrix(rows, ["file.name", "note.status", "note.priority"], def);
    expect(matrix).toEqual([
      ["file.name", "Status", "note.priority"], // note.status has a displayName override
      ["Alpha.md", "Todo", "1"],
      ["Beta.md", "Done", "2"],
    ]);
  });

  it("renders a missing/null property as an empty cell", () => {
    const rows = [row("Alpha", { "file.name": str("Alpha.md"), "note.status": nullValue() })];
    const matrix = buildExportMatrix(rows, ["file.name", "note.status", "note.missing"], def);
    expect(matrix[1]).toEqual(["Alpha.md", "", ""]);
  });
});

describe("matrixToCsv", () => {
  it("joins fields with commas and rows with CRLF", () => {
    expect(matrixToCsv([["a", "b"], ["1", "2"]])).toBe("a,b\r\n1,2");
  });

  it("quotes fields containing commas, quotes, or newlines per RFC 4180", () => {
    expect(matrixToCsv([["a,b", 'he said "hi"', "line1\nline2"]])).toBe('"a,b","he said ""hi""","line1\nline2"');
  });
});

describe("matrixToTsv", () => {
  it("joins fields with tabs and rows with newlines", () => {
    expect(matrixToTsv([["a", "b"], ["1", "2"]])).toBe("a\tb\n1\t2");
  });

  it("flattens embedded tabs/newlines to spaces so paste structure survives", () => {
    expect(matrixToTsv([["a\tb", "c\nd"]])).toBe("a b\tc d");
  });
});

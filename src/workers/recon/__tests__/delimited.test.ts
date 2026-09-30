/**
 * Delimited tokenizer tests — quote discipline, whitespace/formatting
 * normalization, strict rejections, and the exact money conversion. The
 * fixed-point invariant: every amount round-trips through bigint micros,
 * never through a float.
 */
import { describe, expect, it } from "vitest";

import {
  headerMatches,
  optionalCell,
  parseBpsCell,
  parseDelimitedRows,
  parseStatementMoney,
  readStrictTable,
  sniffHeaderMatches,
} from "../delimited";
import { StatementParseError } from "../records";

describe("parseDelimitedRows", () => {
  it("splits CSV rows and drops the trailing blank record", () => {
    const rows = parseDelimitedRows("a,b,c\n1,2,3\n", ",");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("treats CRLF line breaks as record separators", () => {
    const rows = parseDelimitedRows("a,b\r\n1,2\r\n", ",");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("honors quoted fields containing the delimiter and newlines", () => {
    const rows = parseDelimitedRows('a,b\n"x,1","line\nbreak"\n', ",");
    expect(rows).toEqual([["a", "b"], ["x,1", "line\nbreak"]]);
  });

  it("rejects doubled quotes in an unquoted cell — escapes only exist inside quoted fields", () => {
    // RFC 4180: a field not enclosed in quotes may not contain quotes at
    // all. `He said ""hi""` is ambiguous garbage — rejected, never guessed.
    expect(() => parseDelimitedRows('He said ""hi""\n', ",")).toThrow(StatementParseError);
    expect(() => parseDelimitedRows('He said ""hi""\n', ",")).toThrow(/invalid_quoting/);
  });

  it("rejects a quote appended mid-cell (invalid quoting)", () => {
    expect(() => parseDelimitedRows('ab"c\n', ",")).toThrow(StatementParseError);
    expect(() => parseDelimitedRows('ab"c\n', ",")).toThrow(/invalid_quoting/);
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseDelimitedRows('a,"open\n', ",")).toThrow(/unterminated_quote/);
  });

  it("rejects an empty file", () => {
    expect(() => parseDelimitedRows("\n \n", ",")).toThrow(/empty_statement_file/);
  });
});

describe("sniffHeaderMatches / headerMatches", () => {
  const HEADER = ["Statement ID", "Title", "Amount"] as const;

  it("matches an exact header via the sniff probe", () => {
    expect(sniffHeaderMatches("Statement ID,Title,Amount\n1,x,2\n", ",", [...HEADER])).toBe(true);
  });

  it("rejects reordered, extra, or missing columns", () => {
    expect(sniffHeaderMatches("Title,Statement ID,Amount\n", ",", [...HEADER])).toBe(false);
    expect(sniffHeaderMatches("Statement ID,Title\n", ",", [...HEADER])).toBe(false);
    expect(sniffHeaderMatches("Statement ID,Title,Amount,Extra\n", ",", [...HEADER])).toBe(false);
  });

  it("respects quotes when sniffing the first record", () => {
    expect(sniffHeaderMatches('"Statement ID",Title,Amount\n', ",", [...HEADER])).toBe(true);
    expect(sniffHeaderMatches('"Open,quote,Amount\n', ",", [...HEADER])).toBe(false);
  });

  it("compares rows exactly through headerMatches", () => {
    expect(headerMatches([["a", "b"]], ["a", "b"])).toBe(true);
    expect(headerMatches([["a", "b", ""]], ["a", "b"])).toBe(false);
    expect(headerMatches([], ["a", "b"])).toBe(false);
  });
});

describe("readStrictTable", () => {
  const HEADER = ["Name", "Amount", "Currency"] as const;

  it("maps rows to header-keyed cell maps", () => {
    const rows = readStrictTable("Name,Amount,Currency\nX,1.20,USD\n", ",", [...HEADER]);
    expect(rows).toHaveLength(1);
    expect(rows[0].get("Name")).toBe("X");
    expect(rows[0].get("Amount")).toBe("1.20");
    expect(rows[0].get("Currency")).toBe("USD");
  });

  it("rejects a short row instead of silently mapping missing cells", () => {
    expect(() => readStrictTable("Name,Amount,Currency\nX,1.20\n", ",", [...HEADER])).toThrow(
      /column_count_mismatch/,
    );
  });

  it("rejects a header mismatch before any row parses", () => {
    expect(() => readStrictTable("Name,Amount\nX,1\n", ",", [...HEADER])).toThrow(
      /header_mismatch/,
    );
  });
});

describe("parseStatementMoney", () => {
  it("converts plain decimals to 1e-8 micros exactly", () => {
    expect(parseStatementMoney("0.0905").micros).toBe(9_050_000n);
    expect(parseStatementMoney("1152.24").micros).toBe(115_224_000_000n);
    expect(parseStatementMoney("12").micros).toBe(1_200_000_000n);
  });

  it("accepts sender formatting: currency symbol and thousands grouping", () => {
    expect(parseStatementMoney("$4.31").micros).toBe(431_000_000n);
    expect(parseStatementMoney("€1,234.56").micros).toBe(123_456_000_000n);
    expect(parseStatementMoney("$12,345,678.9").micros).toBe(1_234_567_890_000_000n);
  });

  it("carries the negative flag for signed amounts (adjustments)", () => {
    const money = parseStatementMoney("-52.24");
    expect(money.micros).toBe(-5_224_000_000n);
    expect(money.negative).toBe(true);
    expect(parseStatementMoney("52.24").negative).toBe(false);
  });

  it("rejects a European decimal comma instead of misparsing it", () => {
    // "1,50" must never become 150 — the ambiguous grouping survives and
    // the strict converter rejects it.
    expect(() => parseStatementMoney("1,50")).toThrow(/invalid_amount/);
    expect(() => parseStatementMoney("$1,50")).toThrow(/invalid_amount/);
  });

  it("rejects a sign before the currency symbol", () => {
    expect(() => parseStatementMoney("-$5.00")).toThrow(/invalid_amount/);
  });

  it("rejects precision beyond the 1e-8 micros space", () => {
    expect(() => parseStatementMoney("0.000000001")).toThrow(/invalid_amount/);
  });
});

describe("optionalCell", () => {
  it("trims populated cells and nulls empty ones", () => {
    const values = new Map([
      ["A", "  x  "],
      ["B", ""],
    ]);
    expect(optionalCell(values, "A")).toBe("x");
    expect(optionalCell(values, "B")).toBeNull();
    expect(optionalCell(values, "MISSING")).toBeNull();
  });
});

describe("parseBpsCell", () => {
  it("accepts whole basis points up to 10000", () => {
    expect(parseBpsCell("0")).toBe(0);
    expect(parseBpsCell("640")).toBe(640);
    expect(parseBpsCell("10000")).toBe(10000);
  });

  it("rejects decimals, negatives, and out-of-range values", () => {
    expect(() => parseBpsCell("6.4")).toThrow(/invalid_bps/);
    expect(() => parseBpsCell("-1")).toThrow(/invalid_bps/);
    expect(() => parseBpsCell("10001")).toThrow(/invalid_bps/);
  });
});

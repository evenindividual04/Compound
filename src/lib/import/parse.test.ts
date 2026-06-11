import { describe, it, expect } from "vitest";
import { parseFile } from "./parse";
import { buildHdfcCsvBuffer, buildIciciXlsxBuffer } from "./__fixtures__/fixture-builder";

describe("parseFile — CSV", () => {
  it("parses an HDFC-style CSV: skips preamble junk, autodetects header row, returns correct headers and rows", async () => {
    const buf = buildHdfcCsvBuffer();
    const result = await parseFile(buf, "hdfc.csv");
    expect(result.headers).toEqual([
      "Date",
      "Narration",
      "Chq./Ref.No.",
      "Withdrawal Amt.",
      "Deposit Amt.",
      "Closing Balance",
    ]);
    // 4 data rows in fixture
    expect(result.rows).toHaveLength(4);
    // first data row date cell
    expect(result.rows[0][0]).toBe("01/07/26");
    // withdrawal amount with commas
    expect(result.rows[0][3]).toBe("1,500.00");
  });

  it("treats a header as the first row with ≥3 non-empty cells", async () => {
    const buf = buildHdfcCsvBuffer();
    const { headers } = await parseFile(buf, "file.csv");
    expect(headers.length).toBeGreaterThanOrEqual(3);
  });

  it("skips fully-empty rows", async () => {
    // HDFC fixture has an empty line in preamble — rows returned should all be non-empty
    const buf = buildHdfcCsvBuffer();
    const { rows } = await parseFile(buf, "file.csv");
    for (const row of rows) {
      const nonEmpty = row.filter((c) => c.trim() !== "").length;
      expect(nonEmpty).toBeGreaterThan(0);
    }
  });
});

describe("parseFile — XLSX", () => {
  it("parses an ICICI-style XLSX: correct headers and rows with stringified cells", async () => {
    const buf = await buildIciciXlsxBuffer();
    const result = await parseFile(buf, "icici.xlsx");
    expect(result.headers).toContain("Value Date");
    expect(result.headers).toContain("Transaction Remarks");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("formats Excel date cells as dd/MM/yyyy (not serial number)", async () => {
    const buf = await buildIciciXlsxBuffer();
    const { rows } = await parseFile(buf, "icici.xlsx");
    // Value Date (index 1) should look like dd/MM/yyyy not a number
    const dateCell = rows[0][1];
    expect(dateCell).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("formats numeric cells as plain strings without grouping separators", async () => {
    const buf = await buildIciciXlsxBuffer();
    const { headers, rows } = await parseFile(buf, "icici.xlsx");
    // Find "Withdrawal Amount (INR )" column index from the headers
    const withdrawalIdx = headers.findIndex((h) => h.includes("Withdrawal Amount"));
    expect(withdrawalIdx).toBeGreaterThanOrEqual(0);
    const withdrawalCell = rows[0][withdrawalIdx];
    expect(withdrawalCell).not.toContain(",");
    expect(Number.isFinite(Number(withdrawalCell))).toBe(true);
  });
});

describe("parseFile — .xls legacy rejection", () => {
  it("throws a descriptive error for .xls files by filename", async () => {
    const buf = Buffer.from("some binary content");
    await expect(parseFile(buf, "statement.xls")).rejects.toThrow(
      /Legacy .xls is not supported/i,
    );
  });
});

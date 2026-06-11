/**
 * Programmatic fixture builders for import tests.
 * Avoids committing binary files; generates consistent test data.
 */

/**
 * HDFC-style CSV fixture:
 * - preamble junk lines (some with <3 non-empty cells, one empty line)
 * - header row: Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
 * - 4 data rows with dd/MM/yy dates and ₹-formatted amounts with commas
 */
export function buildHdfcCsvBuffer(): Buffer {
  const lines = [
    // junk preamble lines (< 3 non-empty cells each)
    "HDFC Bank Account Statement",
    "Account No:,50100012345678",
    "",
    // header — 6 non-empty cells — will be autodetected
    "Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance",
    // 4 data rows
    '01/07/26,SWIGGY ORDER,000123,"1,500.00","","48,500.00"',
    '02/07/26,SALARY CREDIT COMPANY INC,,,"50,000.00","98,500.00"',
    '03/07/26,ATM WITHDRAWAL 12345,ref456,"2,000.00","","96,500.00"',
    '05/07/26,BILL PAYMENT ELECTRICITY,,,"500.00","97,000.00"',
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

/**
 * ICICI-style XLSX fixture built programmatically with exceljs.
 * Columns: S No., Value Date, Transaction Date, Cheque Number,
 *          Transaction Remarks, Withdrawal Amount (INR ), Deposit Amount (INR ), Balance (INR )
 */
export async function buildIciciXlsxBuffer(): Promise<Buffer> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Statement");

  ws.addRow([
    "S No.",
    "Value Date",
    "Transaction Date",
    "Cheque Number",
    "Transaction Remarks",
    "Withdrawal Amount (INR )",
    "Deposit Amount (INR )",
    "Balance (INR )",
  ]);

  // Row 1: a withdrawal — Value Date and Transaction Date as JS Date objects so
  // exceljs stores them as Excel date serials with numFmt 'dd/mm/yyyy'
  const d1 = new Date("2026-07-01T00:00:00Z");
  const d2 = new Date("2026-07-03T00:00:00Z");

  const r1 = ws.addRow([1, d1, d1, "CHQ001", "SWIGGY ORDER", 1500, 0, 48500]);
  // mark date cells explicitly so exceljs knows to format them
  const dateNumFmt = "dd/mm/yyyy";
  r1.getCell(2).numFmt = dateNumFmt;
  r1.getCell(3).numFmt = dateNumFmt;

  const r2 = ws.addRow([2, d2, d2, "", "SALARY CREDIT", 0, 50000, 98500]);
  r2.getCell(2).numFmt = dateNumFmt;
  r2.getCell(3).numFmt = dateNumFmt;

  const arrayBuf = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

import { describe, it, expect } from "vitest";
import { applyMapping } from "./mapping";
import type { ColumnMapping } from "./mapping";

// ── Date format tests ─────────────────────────────────────────────────────────

describe("applyMapping — date formats", () => {
  const baseMapping = (dateFormat: ColumnMapping["dateFormat"]): ColumnMapping => ({
    date: "Date",
    description: "Narration",
    amount: "Amount",
    dateFormat,
  });

  const headers = ["Date", "Narration", "Amount"];

  it("parses dd/MM/yyyy", () => {
    const { ok, failed } = applyMapping(headers, [["01/07/2026", "Swiggy", "-500"]], {
      ...baseMapping("dd/MM/yyyy"),
    });
    expect(failed).toHaveLength(0);
    expect(ok[0].date).toBe("2026-07-01");
  });

  it("parses dd/MM/yy", () => {
    const { ok, failed } = applyMapping(headers, [["01/07/26", "Swiggy", "-500"]], {
      ...baseMapping("dd/MM/yy"),
    });
    expect(failed).toHaveLength(0);
    expect(ok[0].date).toBe("2026-07-01");
  });

  it("parses dd-MM-yyyy", () => {
    const { ok, failed } = applyMapping(headers, [["01-07-2026", "Swiggy", "-500"]], {
      ...baseMapping("dd-MM-yyyy"),
    });
    expect(failed).toHaveLength(0);
    expect(ok[0].date).toBe("2026-07-01");
  });

  it("parses yyyy-MM-dd", () => {
    const { ok, failed } = applyMapping(headers, [["2026-07-01", "Swiggy", "-500"]], {
      ...baseMapping("yyyy-MM-dd"),
    });
    expect(failed).toHaveLength(0);
    expect(ok[0].date).toBe("2026-07-01");
  });

  it("parses dd MMM yyyy", () => {
    const { ok, failed } = applyMapping(headers, [["01 Jul 2026", "Swiggy", "-500"]], {
      ...baseMapping("dd MMM yyyy"),
    });
    expect(failed).toHaveLength(0);
    expect(ok[0].date).toBe("2026-07-01");
  });

  it("invalid date → failed row, not thrown", () => {
    const { ok, failed } = applyMapping(headers, [["not-a-date", "Swiggy", "-500"]], {
      ...baseMapping("dd/MM/yyyy"),
    });
    expect(ok).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].ordinal).toBe(0);
    expect(failed[0].reason).toMatch(/date/i);
  });
});

// ── Amount cleaning — Cr/Dr suffix ───────────────────────────────────────────

describe("applyMapping — Cr/Dr suffix on single amount column", () => {
  const headers = ["Date", "Narration", "Amount"];
  const mapping: ColumnMapping = {
    date: "Date",
    description: "Narration",
    amount: "Amount",
    dateFormat: "dd/MM/yyyy",
  };

  it("plain negative amount passes through", () => {
    const { ok } = applyMapping(headers, [["01/07/2026", "ATM", "-1000"]], mapping);
    expect(ok[0].amount).toBe("-1000.0000");
  });

  it("Cr suffix → positive", () => {
    const { ok } = applyMapping(headers, [["01/07/2026", "Salary", "50000.00 Cr"]], mapping);
    expect(ok[0].amount).toBe("50000.0000");
  });

  it("CR suffix (uppercase) → positive", () => {
    const { ok } = applyMapping(headers, [["01/07/2026", "Salary", "50000CR"]], mapping);
    expect(ok[0].amount).toBe("50000.0000");
  });

  it("Dr suffix → negative", () => {
    const { ok } = applyMapping(headers, [["01/07/2026", "Swiggy", "500Dr"]], mapping);
    expect(ok[0].amount).toBe("-500.0000");
  });

  it("DR suffix (uppercase) → negative", () => {
    const { ok } = applyMapping(headers, [["01/07/2026", "ATM", "2000 DR"]], mapping);
    expect(ok[0].amount).toBe("-2000.0000");
  });

  it("strips ₹ sign and commas", () => {
    const { ok } = applyMapping(headers, [["01/07/2026", "Bill", "₹1,500.00"]], mapping);
    expect(ok[0].amount).toBe("1500.0000");
  });

  it("strips INR prefix", () => {
    const { ok } = applyMapping(headers, [["01/07/2026", "Bill", "INR1500"]], mapping);
    expect(ok[0].amount).toBe("1500.0000");
  });
});

// ── Amount cleaning — debit/credit pair columns ───────────────────────────────

describe("applyMapping — debit/credit pair columns", () => {
  const headers = ["Date", "Narration", "Debit", "Credit", "Balance"];
  const mapping: ColumnMapping = {
    date: "Date",
    description: "Narration",
    debit: "Debit",
    credit: "Credit",
    balance: "Balance",
    dateFormat: "dd/MM/yyyy",
  };

  it("debit filled, credit blank → negative amount", () => {
    const { ok } = applyMapping(
      headers,
      [["01/07/2026", "Swiggy", "1500", "", "48500"]],
      mapping,
    );
    expect(ok[0].amount).toBe("-1500.0000");
    expect(ok[0].balance).toBe("48500.0000");
  });

  it("credit filled, debit blank → positive amount", () => {
    const { ok } = applyMapping(
      headers,
      [["01/07/2026", "Salary", "", "50000", "98500"]],
      mapping,
    );
    expect(ok[0].amount).toBe("50000.0000");
  });

  it("both blank → failed row", () => {
    const { ok, failed } = applyMapping(
      headers,
      [["01/07/2026", "Unknown", "", "", "98500"]],
      mapping,
    );
    expect(ok).toHaveLength(0);
    expect(failed[0].reason).toMatch(/both.*blank|debit.*credit/i);
  });

  it("both filled → failed row", () => {
    const { ok, failed } = applyMapping(
      headers,
      [["01/07/2026", "Conflict", "100", "200", "98500"]],
      mapping,
    );
    expect(ok).toHaveLength(0);
    expect(failed[0].reason).toMatch(/both.*filled|debit.*credit/i);
  });
});

// ── ref / balance passthrough ─────────────────────────────────────────────────

describe("applyMapping — optional ref and balance columns", () => {
  const headers = ["Date", "Narration", "RefNo", "Amount", "Balance"];
  const mapping: ColumnMapping = {
    date: "Date",
    description: "Narration",
    amount: "Amount",
    ref: "RefNo",
    balance: "Balance",
    dateFormat: "dd/MM/yyyy",
  };

  it("populates externalId from ref column", () => {
    const { ok } = applyMapping(
      headers,
      [["01/07/2026", "Transfer", "REF123", "-500", "48000"]],
      mapping,
    );
    expect(ok[0].externalId).toBe("REF123");
    expect(ok[0].balance).toBe("48000.0000");
  });

  it("blank ref → externalId absent (not undefined key)", () => {
    const { ok } = applyMapping(
      headers,
      [["01/07/2026", "Transfer", "", "-500", "48000"]],
      mapping,
    );
    expect(ok[0].externalId).toBeUndefined();
  });
});

// ── multiple rows, ordinal tracking ──────────────────────────────────────────

describe("applyMapping — ordinal tracking with mixed ok/failed rows", () => {
  it("failed ordinals reflect original row position", () => {
    const headers = ["Date", "Narration", "Amount"];
    const mapping: ColumnMapping = {
      date: "Date",
      description: "Narration",
      amount: "Amount",
      dateFormat: "dd/MM/yyyy",
    };
    const rows = [
      ["01/07/2026", "Row 0", "-100"], // ok
      ["bad-date", "Row 1", "-200"], // failed
      ["03/07/2026", "Row 2", "-300"], // ok
      ["also-bad", "Row 3", "-400"], // failed
    ];
    const { ok, failed } = applyMapping(headers, rows, mapping);
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(2);
    expect(failed[0].ordinal).toBe(1);
    expect(failed[1].ordinal).toBe(3);
  });
});

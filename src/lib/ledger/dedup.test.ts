import { describe, it, expect } from "vitest";
import { normalizeDescription, withOccurrenceHashes } from "./dedup";

const accountId = "00000000-0000-0000-0000-00000000000a";

describe("normalizeDescription", () => {
  it("is case/whitespace insensitive and strips long reference numbers", () => {
    expect(normalizeDescription("  UPI/512345678/Swiggy  Bangalore ")).toBe(
      normalizeDescription("upi/512345678/SWIGGY BANGALORE"),
    );
    expect(normalizeDescription("POS 4523XXXX1234 AMAZON Ref 882910023")).toBe(
      normalizeDescription("POS 4523XXXX1234 AMAZON Ref 110099887"),
    );
  });
  it("keeps short numbers (店 numbers, amounts in text)", () => {
    expect(normalizeDescription("Store 42 purchase")).toContain("42");
  });
});

describe("withOccurrenceHashes", () => {
  const chai = { date: "2026-07-02", amount: "-20.00", description: "UPI-CHAIWALA" };

  it("three identical same-day chai payments get DISTINCT hashes", () => {
    const hashes = withOccurrenceHashes(accountId, [chai, { ...chai }, { ...chai }]).map(
      (r) => r.importHash,
    );
    expect(new Set(hashes).size).toBe(3);
  });

  it("the same logical row re-imported (overlapping statements) collides → duplicate detectable", () => {
    const a = withOccurrenceHashes(accountId, [chai]);
    const b = withOccurrenceHashes(accountId, [chai]);
    expect(a[0].importHash).toBe(b[0].importHash);
  });

  it("occurrence index follows file order within the duplicate group", () => {
    const two = withOccurrenceHashes(accountId, [chai, { ...chai }]);
    const three = withOccurrenceHashes(accountId, [chai, { ...chai }, { ...chai }]);
    expect(three.slice(0, 2).map((r) => r.importHash)).toEqual(two.map((r) => r.importHash));
  });

  it("debit and reversal (same ref, opposite signs) do NOT collide", () => {
    const debit = { date: "2026-07-02", amount: "-500.00", description: "UPI/99887/FAILED MERCHANT" };
    const reversal = { date: "2026-07-02", amount: "500.00", description: "UPI/99887/FAILED MERCHANT" };
    const [d, r] = withOccurrenceHashes(accountId, [debit, reversal]);
    expect(d.importHash).not.toBe(r.importHash);
  });

  it("different accounts never collide", () => {
    const other = "00000000-0000-0000-0000-00000000000b";
    expect(withOccurrenceHashes(accountId, [chai])[0].importHash).not.toBe(
      withOccurrenceHashes(other, [chai])[0].importHash,
    );
  });

  it("preserves input order and passes through the row", () => {
    const rows = [
      { date: "2026-07-01", amount: "-10.00", description: "A" },
      { date: "2026-07-02", amount: "-20.00", description: "B" },
    ];
    const out = withOccurrenceHashes(accountId, rows);
    expect(out.map((r) => r.description)).toEqual(["A", "B"]);
  });
});

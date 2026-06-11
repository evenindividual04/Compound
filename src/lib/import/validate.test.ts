import { describe, it, expect } from "vitest";
import { validateContinuity } from "./validate";

describe("validateContinuity", () => {
  it("returns checked:false when fewer than 2 rows have a balance", () => {
    const rows = [
      { amount: "-100.0000", balance: "900.0000" },
      { amount: "-200.0000" }, // no balance
      { amount: "-50.0000" }, // no balance
    ];
    expect(validateContinuity(rows)).toEqual({ checked: false, breakOrdinals: [] });
  });

  it("returns checked:false when no balance column at all", () => {
    const rows = [
      { amount: "-100.0000" },
      { amount: "-200.0000" },
      { amount: "-300.0000" },
    ];
    expect(validateContinuity(rows)).toEqual({ checked: false, breakOrdinals: [] });
  });

  it("oldest-first statement: clean → no break ordinals", () => {
    // opening balance = 10000
    // row 0: -500 → balance 9500
    // row 1: -200 → balance 9300
    // row 2: +1000 → balance 10300
    const rows = [
      { amount: "-500.0000", balance: "9500.0000" },
      { amount: "-200.0000", balance: "9300.0000" },
      { amount: "1000.0000", balance: "10300.0000" },
    ];
    const result = validateContinuity(rows);
    expect(result.checked).toBe(true);
    expect(result.breakOrdinals).toHaveLength(0);
  });

  it("newest-first statement: auto-detected and passes", () => {
    // Newest first: row 0 is the latest, row N is the oldest.
    // Reading newest-first: each row's balance should be
    //   prev.balance + (-prev.amount) = prev.balance - prev.amount  → wrong way
    // Actually newest-first: balance[n] = balance[n+1] + amount[n+1]
    // Let's build a correct newest-first statement:
    // Underlying oldest-first:
    //   start: 10000
    //   row A: -500 → 9500
    //   row B: -200 → 9300
    //   row C: +1000 → 10300
    // Newest-first ordering:
    //   row 0: amount=+1000, balance=10300
    //   row 1: amount=-200,  balance=9300
    //   row 2: amount=-500,  balance=9500
    const rows = [
      { amount: "1000.0000", balance: "10300.0000" },
      { amount: "-200.0000", balance: "9300.0000" },
      { amount: "-500.0000", balance: "9500.0000" },
    ];
    const result = validateContinuity(rows);
    expect(result.checked).toBe(true);
    expect(result.breakOrdinals).toHaveLength(0);
  });

  it("flags the ordinal where balance continuity breaks", () => {
    // oldest-first, one corrupted row (index 1 has wrong balance)
    const rows = [
      { amount: "-500.0000", balance: "9500.0000" },
      { amount: "-200.0000", balance: "9999.0000" }, // ← wrong, should be 9300
      { amount: "1000.0000", balance: "10999.0000" }, // continues from wrong balance (consistent)
    ];
    const result = validateContinuity(rows);
    expect(result.checked).toBe(true);
    // Row 1 breaks: prev.balance 9500 + amount -200 = 9300 ≠ 9999
    expect(result.breakOrdinals).toContain(1);
  });

  it("tolerance: ≤0.01 discrepancy is not flagged", () => {
    // oldest-first, tiny rounding in row 1
    const rows = [
      { amount: "-500.0000", balance: "9500.0000" },
      { amount: "-200.0010", balance: "9300.0000" }, // off by 0.001 — within tolerance
      { amount: "1000.0000", balance: "10300.0000" },
    ];
    const result = validateContinuity(rows);
    expect(result.checked).toBe(true);
    // Small discrepancy (0.001) should not be a break
    expect(result.breakOrdinals).not.toContain(1);
  });
});

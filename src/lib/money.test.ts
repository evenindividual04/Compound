import { describe, it, expect } from "vitest";
import { add, sub, neg, cmp, isZero, formatINR, formatINRCompact, allocate } from "./money";

describe("money arithmetic (strings in, strings out)", () => {
  it("adds without float error", () => expect(add("0.1", "0.2")).toBe("0.3000"));
  it("subtracts into negatives", () => expect(sub("100.00", "150.25")).toBe("-50.2500"));
  it("negates", () => expect(neg("45000.0000")).toBe("-45000.0000"));
  it("compares", () => {
    expect(cmp("2.00", "10.00")).toBe(-1);
    expect(isZero("0.0000")).toBe(true);
  });
  // edge cases
  it("adds to zero", () => expect(add("0", "0")).toBe("0.0000"));
  it("zero isZero", () => expect(isZero("0")).toBe(true));
  it("non-zero isZero false", () => expect(isZero("0.0001")).toBe(false));
  it("cmp equal", () => expect(cmp("5.00", "5.00")).toBe(0));
  it("cmp greater", () => expect(cmp("10.00", "2.00")).toBe(1));
});

describe("formatINR (en-IN, lakh/crore)", () => {
  // Note: Intl.NumberFormat("en-IN", {style:"currency",currency:"INR"}) on this Node version
  // produces no space after ₹ symbol (e.g. "₹1,23,456.78" not "₹ 1,23,456.78").
  // Negative amounts: Intl produces "-₹5,000" with a regular hyphen, but our impl
  // wraps abs() value with a typographic minus (U+2212) prefix: "−₹5,000".
  //
  // Paise rule: <₹1,000 → keep paise (fmt2); ₹1,000–₹99,999 → drop paise/round (fmt0);
  // ≥₹1,00,000 → keep paise (fmt2). Rationale: at ≥1L scale the exact paise are still
  // shown ("groups 3-2-2" test verifies grouping on a 6-digit amount with paise).
  it("groups 3-2-2 and keeps paise ≥ 1L", () => expect(formatINR("123456.78")).toBe("₹1,23,456.78"));
  it("drops paise ≥ ₹1,000 (< 1L)", () => expect(formatINR("1234.56")).toBe("₹1,235"));
  it("keeps paise < ₹1,000", () => expect(formatINR("342.50")).toBe("₹342.50"));
  it("negative", () => expect(formatINR("-5000")).toBe("−₹5,000"));
  // edge cases
  it("zero", () => expect(formatINR("0")).toBe("₹0.00"));
  it("half-rupee < 1000", () => expect(formatINR("0.5")).toBe("₹0.50"));
  it("exactly 1000", () => expect(formatINR("1000")).toBe("₹1,000"));
  it("exactly 99999.99", () => expect(formatINR("99999.99")).toBe("₹1,00,000"));
  it("exactly 100000", () => expect(formatINR("100000")).toBe("₹1,00,000.00"));
  it("negative compact boundary", () => expect(formatINR("-342.50")).toBe("−₹342.50"));
});

describe("formatINRCompact (L/Cr notation)", () => {
  it("compact lakh", () => expect(formatINRCompact("234500")).toBe("₹2.3L"));
  it("compact crore", () => expect(formatINRCompact("12300000")).toBe("₹1.2Cr"));
  // edge cases
  it("negative compact lakh", () => expect(formatINRCompact("-500000")).toBe("−₹5.0L"));
  it("compact large crore", () => expect(formatINRCompact("1000000000")).toBe("₹100.0Cr"));
  it("sub-lakh sub-1k", () => expect(formatINRCompact("500")).toBe("₹500.00"));
});

describe("allocate (largest remainder — splits always sum exactly)", () => {
  it("splits 100 three ways with no lost paisa", () => {
    const parts = allocate("100.00", 3);
    // 4dp canonical: floor(100/3, 4dp) = 33.3333; remainder = 0.0001 → first gets 33.3334
    // (Original spec showed ["33.3400","33.3300","33.3300"] — that was 2dp base math;
    //  4dp canonical is more precise and still sums exactly.)
    expect(parts).toEqual(["33.3334", "33.3333", "33.3333"]);
    expect(parts.reduce((a, b) => add(a, b))).toBe("100.0000");
  });
  // edge cases
  it("even split", () => {
    const parts = allocate("90.00", 3);
    expect(parts).toEqual(["30.0000", "30.0000", "30.0000"]);
    expect(parts.reduce((a, b) => add(a, b))).toBe("90.0000");
  });
  it("split into 1 returns total", () => {
    const parts = allocate("45.50", 1);
    expect(parts).toEqual(["45.5000"]);
  });
});

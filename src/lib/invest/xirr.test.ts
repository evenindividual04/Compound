import { describe, it, expect } from "vitest";
import { xirr } from "./xirr";

describe("xirr", () => {
  it("computes ~10% for a one-year flow", () => {
    const r = xirr([
      { date: "2025-01-01", amount: "-1000" },
      { date: "2026-01-01", amount: "1100" },
    ]);
    expect(r).not.toBeNull();
    expect(Number(r)).toBeCloseTo(0.1, 3);
  });

  it("handles multiple contributions (SIP-like)", () => {
    const r = xirr([
      { date: "2025-01-01", amount: "-1000" },
      { date: "2025-07-01", amount: "-1000" },
      { date: "2026-01-01", amount: "2200" },
    ]);
    expect(r).not.toBeNull();
    expect(Number(r)).toBeGreaterThan(0);
  });

  it("returns null when all flows share a sign", () => {
    expect(xirr([{ date: "2025-01-01", amount: "-1000" }, { date: "2026-01-01", amount: "-500" }])).toBeNull();
  });
});

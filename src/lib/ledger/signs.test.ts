import { describe, it, expect } from "vitest";
import { normalizeBalanceForKind } from "./signs";

describe("normalizeBalanceForKind", () => {
  // LIABILITY_KINDS: credit_card, loan, other_liability

  describe("credit_card (liability)", () => {
    it("stores positive input as negative", () => {
      expect(normalizeBalanceForKind("credit_card", "45000")).toBe("-45000.0000");
    });

    it("stores already-negative input as negative (idempotent abs then neg)", () => {
      // User passes "-45000" (e.g. pre-normalised) → still stored as "-45000.0000"
      expect(normalizeBalanceForKind("credit_card", "-45000")).toBe("-45000.0000");
    });

    it("handles zero correctly (neg(0) = 0, not negative zero)", () => {
      // Decimal.js does not produce negative zero; zero liability balance is stored as 0.0000.
      expect(normalizeBalanceForKind("credit_card", "0")).toBe("0.0000");
    });
  });

  describe("loan (liability)", () => {
    it("stores positive input as negative", () => {
      expect(normalizeBalanceForKind("loan", "250000")).toBe("-250000.0000");
    });

    it("handles decimal input", () => {
      expect(normalizeBalanceForKind("loan", "1500.50")).toBe("-1500.5000");
    });
  });

  describe("other_liability (liability)", () => {
    it("stores positive input as negative", () => {
      expect(normalizeBalanceForKind("other_liability", "10000")).toBe("-10000.0000");
    });
  });

  describe("asset kinds (passthrough)", () => {
    it("bank: returns value unchanged", () => {
      expect(normalizeBalanceForKind("bank", "50000")).toBe("50000");
    });

    it("cash: returns value unchanged", () => {
      expect(normalizeBalanceForKind("cash", "500")).toBe("500");
    });

    it("investment: returns value unchanged", () => {
      expect(normalizeBalanceForKind("investment", "200000.5000")).toBe("200000.5000");
    });

    it("epf: returns value unchanged", () => {
      expect(normalizeBalanceForKind("epf", "350000")).toBe("350000");
    });

    it("zero for asset kind", () => {
      expect(normalizeBalanceForKind("bank", "0")).toBe("0");
    });

    it("unknown kind: passthrough (defensive)", () => {
      expect(normalizeBalanceForKind("wallet", "100")).toBe("100");
    });
  });
});

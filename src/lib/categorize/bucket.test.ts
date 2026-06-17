import { describe, it, expect } from "vitest";
import { amountBucket } from "./bucket";
describe("amountBucket", () => {
  it("buckets by magnitude, sign-agnostic", () => {
    expect(amountBucket("-642.0000")).toBe("₹100–1k");
    expect(amountBucket("-50.0000")).toBe("<₹100");
    expect(amountBucket("12000.0000")).toBe("₹10k–1L");
  });
});

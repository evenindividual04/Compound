import { describe, it, expect } from "vitest";
import { redactForLlm } from "./redact";
describe("redactForLlm", () => {
  it("keeps brand merchants", () => { expect(redactForLlm("Zomato")).toBe("Zomato"); });
  it("strips long digit runs and masked account tokens", () => {
    expect(redactForLlm("UPI/9876543210/payment")).toBe("UPI payment");
    expect(redactForLlm("ACH DR XXXXXX1234 NETFLIX")).toBe("ACH DR NETFLIX");
  });
  it("fails closed when nothing safe remains", () => {
    expect(redactForLlm("987654321098")).toBeNull();
  });
});

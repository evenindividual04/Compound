import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isAllowed } from "./allowlist";

describe("isAllowed", () => {
  const OWNER = "owner@example.com";

  beforeEach(() => {
    process.env.OWNER_EMAIL = OWNER;
  });

  afterEach(() => {
    delete process.env.OWNER_EMAIL;
  });

  it("returns true for exact match", () => {
    expect(isAllowed("owner@example.com")).toBe(true);
  });

  it("returns true for different case", () => {
    expect(isAllowed("Owner@Example.COM")).toBe(true);
  });

  it("returns false for different email", () => {
    expect(isAllowed("other@example.com")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAllowed(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAllowed(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAllowed("")).toBe(false);
  });
});

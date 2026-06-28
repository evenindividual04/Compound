import { describe, it, expect, afterEach } from "vitest";
import { e2eBypassEnabled, e2eOwnerSession, E2E_OWNER_ID } from "./e2e-session";

// NODE_ENV is typed readonly; use Object.assign to mutate it in tests without tsc errors.
const setNodeEnv = (v: string) => Object.assign(process.env, { NODE_ENV: v });

const orig = { node: process.env.NODE_ENV, flag: process.env.E2E_AUTH_BYPASS, owner: process.env.OWNER_EMAIL };
afterEach(() => {
  setNodeEnv(orig.node ?? "test");
  process.env.E2E_AUTH_BYPASS = orig.flag;
  process.env.OWNER_EMAIL = orig.owner;
});

describe("e2e auth seam", () => {
  it("is enabled only when non-production AND the flag is set", () => {
    setNodeEnv("test"); process.env.E2E_AUTH_BYPASS = "1";
    expect(e2eBypassEnabled()).toBe(true);
  });
  it("is INERT in production even with the flag set", () => {
    setNodeEnv("production"); process.env.E2E_AUTH_BYPASS = "1";
    expect(e2eBypassEnabled()).toBe(false);
    expect(e2eOwnerSession()).toBeNull();
  });
  it("is inert when the flag is absent", () => {
    setNodeEnv("test"); delete process.env.E2E_AUTH_BYPASS;
    expect(e2eBypassEnabled()).toBe(false);
    expect(e2eOwnerSession()).toBeNull();
  });
  it("returns the owner session when enabled", () => {
    setNodeEnv("test"); process.env.E2E_AUTH_BYPASS = "1"; process.env.OWNER_EMAIL = "owner@example.com";
    expect(e2eOwnerSession()).toEqual({ user: { id: E2E_OWNER_ID, email: "owner@example.com" } });
  });
});

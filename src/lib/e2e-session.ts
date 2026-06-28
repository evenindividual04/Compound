/**
 * Test-only auth bypass for browser E2E. DOUBLE-GATED: active only when
 * NODE_ENV !== "production" AND E2E_AUTH_BYPASS === "1". In any production
 * build this is dead code — e2eBypassEnabled() is false and e2eOwnerSession()
 * returns null, so proxy.ts / current.ts fall through to real better-auth.
 * Deliberately NOT in the typed env schema so it can never become required.
 */
export const E2E_OWNER_ID = "e2e-owner";

export function e2eBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.E2E_AUTH_BYPASS === "1";
}

export function e2eOwnerSession(): { user: { id: string; email: string } } | null {
  if (!e2eBypassEnabled()) return null;
  const email = process.env.OWNER_EMAIL;
  if (!email) return null;
  return { user: { id: E2E_OWNER_ID, email } };
}

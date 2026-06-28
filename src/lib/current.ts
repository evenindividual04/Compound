/**
 * Resolve the authenticated user's household for server actions and RSCs.
 * Single source of truth — every server action calls this; none re-implement
 * session plumbing. Throws on any failure: the proxy layer should have
 * already guaranteed an allowed session, so a miss here is a bug or an attack.
 */
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { isAllowed } from "@/lib/allowlist";
import { db } from "@/db";
import { users } from "@/db/schema";
import { e2eBypassEnabled, e2eOwnerSession } from "@/lib/e2e-session";

export interface Current {
  userId: string;
  email: string;
  householdId: string;
}

export async function requireHousehold(): Promise<Current> {
  const session = e2eBypassEnabled()
    ? e2eOwnerSession()
    : await auth.api.getSession({ headers: await headers() });
  if (!session || !isAllowed(session.user.email)) throw new Error("unauthorized");
  const [mapping] = await db.select().from(users).where(eq(users.id, session.user.id));
  if (!mapping) throw new Error("no household mapping for user");
  return { userId: session.user.id, email: session.user.email, householdId: mapping.householdId };
}

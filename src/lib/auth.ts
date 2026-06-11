import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import { env } from "@/env";
import { authUser, authSession, authAccount, authVerification } from "@/db/schema/auth";
import { users, households } from "@/db/schema/core";
import { isAllowed } from "@/lib/allowlist";
import { eq } from "drizzle-orm";

// Map better-auth model names → our custom-named Drizzle table objects.
// Required because our schema already exports `accounts` (bank accounts) and
// `users` (household mapping), so the auth tables use prefixed export names.
const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),

  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Defense layer 1: block any sign-in whose email is not the owner.
        before: async (user) => {
          if (!isAllowed(user.email)) {
            throw new Error("Unauthorized: email not on allowlist");
          }
        },

        // After first user creation, insert a row into our `users` mapping
        // table linked to the first household (seeded).
        after: async (user) => {
          const [household] = await db
            .select({ id: households.id })
            .from(households)
            .limit(1);
          if (!household) return;

          await db
            .insert(users)
            .values({ id: user.id, householdId: household.id, email: user.email })
            .onConflictDoNothing();
        },
      },
    },
  },
});

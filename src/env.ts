import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    OWNER_EMAIL: z.email(),
    CRON_SECRET: z.string().min(16),
    INGEST_SECRET: z.string().min(16),
    // AI Gateway model override. Defaults to "anthropic/claude-haiku-4-5".
    // Auth uses AI_GATEWAY_API_KEY or Vercel OIDC — no key needed in local dev when calls are mocked.
    CATEGORIZER_MODEL: z.string().optional(),
  },
  client: {},
  experimental__runtimeEnv: {},
});

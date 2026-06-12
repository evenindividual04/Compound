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
  },
  client: {},
  experimental__runtimeEnv: {},
});

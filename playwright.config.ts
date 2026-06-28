import { defineConfig } from "@playwright/test";

const E2E_DB = "postgresql://compound@127.0.0.1:54329/compound_e2e";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false, // single shared DB
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3100",
    viewport: { width: 390, height: 844 }, // iPhone-like — the app is mobile-first
  },
  webServer: {
    command: "next dev -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: E2E_DB,
      E2E_AUTH_BYPASS: "1",
      NODE_ENV: "development",
      INGEST_SECRET: process.env.INGEST_SECRET ?? "dev_ingest_secret_change_me_01",
      OWNER_EMAIL: process.env.OWNER_EMAIL ?? "owner@example.com",
    } as Record<string, string>,
  },
});

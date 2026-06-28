import { Pool } from "pg";

const E2E_DB = "postgresql://compound@127.0.0.1:54329/compound_e2e";
const OWNER_ID = "e2e-owner";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "owner@example.com";

export default async function globalSetup() {
  const pool = new Pool({ connectionString: E2E_DB });

  // Clean slate — order matters for FK constraints.
  // Truncate leaf tables first, then parent tables.
  await pool.query(`
    TRUNCATE
      entry_events, transaction_splits, valuations, transfers,
      entries, import_rows, imports, ledger_anomalies, balances,
      rollups, categories, accounts, users, households,
      auth_session, auth_account, auth_user
    RESTART IDENTITY CASCADE
  `);

  // auth_user columns (from src/db/schema/auth.ts):
  //   id TEXT PK, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  //   email_verified BOOLEAN NOT NULL DEFAULT false,
  //   image TEXT (nullable),
  //   created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  //   updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  await pool.query(
    `INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'E2E Owner', $2, true, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID, OWNER_EMAIL],
  );

  const hh = (
    await pool.query(
      "INSERT INTO households (name) VALUES ('e2e') RETURNING id",
    )
  ).rows[0] as { id: string };

  await pool.query(
    `INSERT INTO users (id, household_id, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID, hh.id, OWNER_EMAIL],
  );

  // Seed one SBI-keyed bank account (needed for SMS ingest to match smsKey "SBI:3519")
  await pool.query(
    `INSERT INTO accounts (household_id, name, kind, opening_balance, opening_date, metadata)
     VALUES ($1, 'SBI', 'bank', '10000', '2026-01-01', $2)`,
    [hh.id, JSON.stringify({ smsKey: "SBI:3519" })],
  );

  // Seed two expense categories so quick-add has choices
  await pool.query(
    `INSERT INTO categories (household_id, name, classification)
     VALUES ($1, 'Food & Dining', 'expense'), ($1, 'Groceries', 'expense')`,
    [hh.id],
  );

  await pool.end();
}

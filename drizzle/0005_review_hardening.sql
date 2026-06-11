-- Chassis review hardening (see review findings, 2026-06-11):
-- 1. btree unique indexes treat NULLs as distinct — the uncategorized rollup row
--    and root categories need partial unique indexes or they can silently stack.
CREATE UNIQUE INDEX "rollups_pk_null_cat" ON "rollups" ("household_id", "month")
  WHERE "category_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_root_name" ON "categories" ("household_id", "name")
  WHERE "parent_id" IS NULL;--> statement-breakpoint
-- 2. hot-path lookups for the rules engine and nightly anomaly dedup.
CREATE INDEX "rules_household_active" ON "rules" ("household_id") WHERE "active";--> statement-breakpoint
CREATE INDEX "ledger_anomalies_open_hash" ON "ledger_anomalies" ("detail_hash")
  WHERE "resolved_at" IS NULL;

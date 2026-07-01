import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  numeric,
  date,
  boolean,
  uniqueIndex,
  index,
  vector,
} from "drizzle-orm/pg-core";
import { households, categories } from "./core";

export const imports = pgTable("imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  accountId: uuid("account_id").notNull(),
  filename: text("filename").notNull(),
  status: text("status", { enum: ["parsing", "staged", "committed", "undone", "failed"] })
    .notNull()
    .default("parsing"),
  stats: jsonb("stats").$type<{
    total: number;
    new: number;
    duplicates: number;
    suspicious: number;
  }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const importRows = pgTable("import_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  importId: uuid("import_id")
    .notNull()
    .references(() => imports.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  raw: jsonb("raw").notNull(),
  parsed: jsonb("parsed").$type<{
    date: string;
    amount: string;
    description: string;
    externalId?: string;
    balance?: string;
  }>(),
  verdict: text("verdict", { enum: ["new", "duplicate", "suspicious"] }),
  entryId: uuid("entry_id"),
});

// saved column mapping per account ("set up once, reuse monthly")
export const importConfigs = pgTable("import_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().unique(),
  mapping: jsonb("mapping").notNull(),
});

export const rules = pgTable("rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(0),
  active: boolean("active").notNull().default(true),
  matchMode: text("match_mode", { enum: ["all", "any"] })
    .notNull()
    .default("all"),
  conditions: jsonb("conditions")
    .$type<
      { field: "description" | "merchant" | "amount"; op: "contains" | "equals" | "gt" | "lt"; value: string }[]
    >()
    .notNull(),
  actions: jsonb("actions")
    .$type<{ type: "set_category" | "set_merchant" | "add_tag"; value: string }[]>()
    .notNull(),
});

export const budgetAllocations = pgTable(
  "budget_allocations",
  {
    householdId: uuid("household_id").notNull(),
    month: date("month").notNull(),
    categoryId: uuid("category_id").notNull(),
    assigned: numeric("assigned", { precision: 19, scale: 4, mode: "string" })
      .notNull()
      .default("0"),
  },
  (t) => [uniqueIndex("budget_pk").on(t.householdId, t.month, t.categoryId)],
);

export const ledgerAnomalies = pgTable("ledger_anomalies", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  detailHash: text("detail_hash").notNull(),
  detail: jsonb("detail").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const bridgeHeartbeats = pgTable("bridge_heartbeats", {
  householdId: uuid("household_id")
    .primaryKey()
    .references(() => households.id),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
});

export const categorizationExamples = pgTable(
  "categorization_examples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull().references(() => households.id),
    text: text("text").notNull(),               // normalized merchant/description
    categoryId: uuid("category_id").notNull().references(() => categories.id),
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
    source: text("source", { enum: ["accept", "correct"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("catex_identity").on(t.householdId, t.text, t.categoryId),
    index("catex_embedding").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

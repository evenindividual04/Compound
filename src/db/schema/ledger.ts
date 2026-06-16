import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  numeric,
  pgEnum,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts, categories, households } from "./core";

export const entryType = pgEnum("entry_type", ["transaction", "trade", "valuation"]);
export const entryStatus = pgEnum("entry_status", ["pending", "posted", "reconciled"]);

/**
 * The immutable truth. Financial core (account_id, entry_type, date, amount, currency)
 * is frozen once status = reconciled; annotations live in subtype tables and are audited
 * via entry_events. Balances are derived strictly as opening + Σ(transaction|trade);
 * valuation entries are anchors, never summed.
 */
export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    entryType: entryType("entry_type").notNull(),
    date: date("date").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4, mode: "string" }).notNull(),
    currency: text("currency").notNull().default("INR"),
    description: text("description").notNull().default(""),
    status: entryStatus("status").notNull().default("posted"),
    externalId: text("external_id"),
    importId: uuid("import_id"),
    importHash: text("import_hash"),
    source: text("source", { enum: ["manual", "import", "system"] })
      .notNull()
      .default("manual"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("entries_account_date").on(t.accountId, t.date),
    // partial unique indexes (dedup ignores tombstones) live in the hardening migration
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    entryId: uuid("entry_id")
      .primaryKey()
      .references(() => entries.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id),
    merchant: text("merchant"),
    // typed lock: once a user sets the category, rules/imports never overwrite it
    categoryLocked: boolean("category_locked").notNull().default(false),
    isAdjustment: boolean("is_adjustment").notNull().default(false),
  },
  (t) => [index("transactions_category").on(t.categoryId)],
);

export const transactionSplits = pgTable("transaction_splits", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id")
    .notNull()
    .references(() => entries.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => categories.id),
  amount: numeric("amount", { precision: 19, scale: 4, mode: "string" }).notNull(),
  note: text("note"),
});

export const valuations = pgTable("valuations", {
  entryId: uuid("entry_id")
    .primaryKey()
    .references(() => entries.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["opening_anchor", "reconciliation", "appraisal"] })
    .notNull()
    .default("reconciliation"),
});

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  outflowEntryId: uuid("outflow_entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "restrict" }),
  inflowEntryId: uuid("inflow_entry_id")
    .notNull()
    .unique()
    .references(() => entries.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["pending", "confirmed"] })
    .notNull()
    .default("pending"),
});

// auto-match pairs the user dismissed — never re-proposed
export const rejectedTransfers = pgTable(
  "rejected_transfers",
  {
    outflowEntryId: uuid("outflow_entry_id").notNull(),
    inflowEntryId: uuid("inflow_entry_id").notNull(),
  },
  (t) => [uniqueIndex("rejected_pair").on(t.outflowEntryId, t.inflowEntryId)],
);

// append-only audit of annotation changes; the log is the real immutability guarantee
export const entryEvents = pgTable(
  "entry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // RESTRICT: the audit log blocks hard-deletes of entries, never vice versa
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "restrict" }),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    source: text("source").notNull(), // 'user' | 'rule:<id>' | 'import:<id>' | 'system'
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("entry_events_entry").on(t.entryId)],
);

export const entryTags = pgTable(
  "entry_tags",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull(),
  },
  (t) => [uniqueIndex("entry_tag_pair").on(t.entryId, t.tagId)],
);

// ---- derived caches: rebuildable from entries at any time, never authoritative ----

export const balances = pgTable(
  "balances",
  {
    accountId: uuid("account_id").notNull(),
    date: date("date").notNull(),
    balance: numeric("balance", { precision: 19, scale: 4, mode: "string" }).notNull(),
  },
  (t) => [uniqueIndex("balances_pk").on(t.accountId, t.date)],
);

export const rollups = pgTable(
  "rollups",
  {
    householdId: uuid("household_id").notNull(),
    month: date("month").notNull(), // first day of month
    categoryId: uuid("category_id"), // null = uncategorized
    amount: numeric("amount", { precision: 19, scale: 4, mode: "string" }).notNull(),
  },
  (t) => [uniqueIndex("rollups_pk").on(t.householdId, t.month, t.categoryId)],
);

// ── P2: investments ───────────────────────────────────────────────────────────
export const instrumentKind = pgEnum("instrument_kind", ["mf", "equity"]);
export const tradeSide = pgEnum("trade_side", ["buy", "sell"]);

export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    kind: instrumentKind("kind").notNull(),
    name: text("name").notNull(),
    symbol: text("symbol"),
    isin: text("isin"),
    amfiCode: text("amfi_code"),
  },
  (t) => [
    uniqueIndex("instruments_isin").on(t.householdId, t.isin).where(sql`${t.isin} IS NOT NULL`),
    uniqueIndex("instruments_symbol")
      .on(t.householdId, t.symbol)
      .where(sql`${t.symbol} IS NOT NULL`),
    uniqueIndex("instruments_amfi")
      .on(t.householdId, t.amfiCode)
      .where(sql`${t.amfiCode} IS NOT NULL`),
    check(
      "instruments_has_identifier",
      sql`${t.isin} IS NOT NULL OR ${t.symbol} IS NOT NULL OR ${t.amfiCode} IS NOT NULL`,
    ),
  ],
);

export const trades = pgTable("trades", {
  entryId: uuid("entry_id")
    .primaryKey()
    .references(() => entries.id, { onDelete: "cascade" }),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => instruments.id, { onDelete: "restrict" }),
  side: tradeSide("side").notNull(),
  units: numeric("units", { precision: 24, scale: 6, mode: "string" }).notNull(),
  price: numeric("price", { precision: 24, scale: 6, mode: "string" }).notNull(),
});

export const prices = pgTable(
  "prices",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    nav: numeric("nav", { precision: 24, scale: 6, mode: "string" }).notNull(),
  },
  (t) => [uniqueIndex("prices_instrument_date").on(t.instrumentId, t.date)],
);

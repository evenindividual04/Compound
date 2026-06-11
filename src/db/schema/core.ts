import {
  pgTable,
  uuid,
  text,
  boolean,
  date,
  timestamp,
  numeric,
  pgEnum,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const accountKind = pgEnum("account_kind", [
  "bank",
  "cash",
  "credit_card",
  "loan",
  "investment",
  "epf",
  "ppf",
  "fd",
  "property",
  "gold",
  "crypto",
  "wallet",
  "receivable",
  "other_asset",
  "other_liability",
]);

export const LIABILITY_KINDS = ["credit_card", "loan", "other_liability"] as const;
export type AccountKind = (typeof accountKind.enumValues)[number];
export const isLiabilityKind = (kind: AccountKind) =>
  (LIABILITY_KINDS as readonly string[]).includes(kind);

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Better Auth manages its own user/session tables; this maps an auth user to a household.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id),
  email: text("email").notNull().unique(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id),
  name: text("name").notNull(),
  kind: accountKind("kind").notNull(),
  currency: text("currency").notNull().default("INR"),
  status: text("status", { enum: ["active", "closed"] })
    .notNull()
    .default("active"),
  excluded: boolean("excluded").notNull().default(false),
  openingDate: date("opening_date"),
  openingBalance: numeric("opening_balance", { precision: 19, scale: 4, mode: "string" })
    .notNull()
    .default("0"),
  metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    classification: text("classification", { enum: ["income", "expense"] })
      .notNull()
      .default("expense"),
    // 'adjustment' marks the reserved reconciliation category; not user-deletable.
    system: text("system"),
  },
  (t) => [uniqueIndex("categories_hh_parent_name").on(t.householdId, t.parentId, t.name)],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("tags_hh_name").on(t.householdId, t.name)],
);

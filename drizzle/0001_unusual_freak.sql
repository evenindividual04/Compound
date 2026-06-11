CREATE TYPE "public"."entry_status" AS ENUM('pending', 'posted', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."entry_type" AS ENUM('transaction', 'trade', 'valuation');--> statement-breakpoint
CREATE TABLE "balances" (
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"balance" numeric(19, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"entry_type" "entry_type" NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "entry_status" DEFAULT 'posted' NOT NULL,
	"external_id" text,
	"import_id" uuid,
	"import_hash" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"source" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_tags" (
	"entry_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejected_transfers" (
	"outflow_entry_id" uuid NOT NULL,
	"inflow_entry_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rollups" (
	"household_id" uuid NOT NULL,
	"month" date NOT NULL,
	"category_id" uuid,
	"amount" numeric(19, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"category_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid,
	"merchant" text,
	"category_locked" boolean DEFAULT false NOT NULL,
	"is_adjustment" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outflow_entry_id" uuid NOT NULL,
	"inflow_entry_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "transfers_outflow_entry_id_unique" UNIQUE("outflow_entry_id"),
	CONSTRAINT "transfers_inflow_entry_id_unique" UNIQUE("inflow_entry_id")
);
--> statement-breakpoint
CREATE TABLE "valuations" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'reconciliation' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_allocations" (
	"household_id" uuid NOT NULL,
	"month" date NOT NULL,
	"category_id" uuid NOT NULL,
	"assigned" numeric(19, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mapping" jsonb NOT NULL,
	CONSTRAINT "import_configs_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"parsed" jsonb,
	"verdict" text,
	"entry_id" uuid
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"status" text DEFAULT 'parsing' NOT NULL,
	"stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"detail_hash" text NOT NULL,
	"detail" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"match_mode" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_tags" ADD CONSTRAINT "entry_tags_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_outflow_entry_id_entries_id_fk" FOREIGN KEY ("outflow_entry_id") REFERENCES "public"."entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_inflow_entry_id_entries_id_fk" FOREIGN KEY ("inflow_entry_id") REFERENCES "public"."entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "balances_pk" ON "balances" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "entries_account_date" ON "entries" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "entry_events_entry" ON "entry_events" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_tag_pair" ON "entry_tags" USING btree ("entry_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rejected_pair" ON "rejected_transfers" USING btree ("outflow_entry_id","inflow_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rollups_pk" ON "rollups" USING btree ("household_id","month","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_pk" ON "budget_allocations" USING btree ("household_id","month","category_id");
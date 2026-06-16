CREATE TYPE "public"."instrument_kind" AS ENUM('mf', 'equity');--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" "instrument_kind" NOT NULL,
	"name" text NOT NULL,
	"symbol" text,
	"isin" text,
	"amfi_code" text
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"instrument_id" uuid NOT NULL,
	"date" date NOT NULL,
	"nav" numeric(24, 6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"instrument_id" uuid NOT NULL,
	"side" text NOT NULL,
	"units" numeric(24, 6) NOT NULL,
	"price" numeric(24, 6) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_identity" ON "instruments" USING btree ("household_id","kind",coalesce("isin", "symbol", "amfi_code"));--> statement-breakpoint
CREATE UNIQUE INDEX "prices_instrument_date" ON "prices" USING btree ("instrument_id","date");
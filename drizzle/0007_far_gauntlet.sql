CREATE TYPE "public"."trade_side" AS ENUM('buy', 'sell');--> statement-breakpoint
ALTER TABLE "trades" DROP CONSTRAINT "trades_instrument_id_instruments_id_fk";
--> statement-breakpoint
DROP INDEX "instruments_identity";--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "side" SET DATA TYPE "public"."trade_side" USING "side"::"public"."trade_side";--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_isin" ON "instruments" USING btree ("household_id","isin") WHERE "instruments"."isin" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_symbol" ON "instruments" USING btree ("household_id","symbol") WHERE "instruments"."symbol" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_amfi" ON "instruments" USING btree ("household_id","amfi_code") WHERE "instruments"."amfi_code" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_has_identifier" CHECK ("instruments"."isin" IS NOT NULL OR "instruments"."symbol" IS NOT NULL OR "instruments"."amfi_code" IS NOT NULL);
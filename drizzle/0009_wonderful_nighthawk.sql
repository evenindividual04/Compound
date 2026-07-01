CREATE TABLE "bridge_heartbeats" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_heartbeats" ADD CONSTRAINT "bridge_heartbeats_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;
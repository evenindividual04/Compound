CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "categorization_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"text" text NOT NULL,
	"category_id" uuid NOT NULL,
	"embedding" vector(384) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categorization_examples" ADD CONSTRAINT "categorization_examples_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_examples" ADD CONSTRAINT "categorization_examples_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catex_identity" ON "categorization_examples" USING btree ("household_id","text","category_id");--> statement-breakpoint
CREATE INDEX "catex_embedding" ON "categorization_examples" USING hnsw ("embedding" vector_cosine_ops);
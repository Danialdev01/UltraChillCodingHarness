ALTER TABLE "notes" ADD COLUMN "cover" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "notes" SET "search_text" = coalesce((SELECT string_agg(t #>> '{}', ' ') FROM jsonb_path_query("content", 'strict $.**.text ? (@.type() == "string")') t), '');

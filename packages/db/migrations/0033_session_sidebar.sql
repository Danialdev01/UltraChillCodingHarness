ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sidebar_mode" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_last_activity_idx" ON "threads" USING btree ("project_id","last_activity_at");--> statement-breakpoint
-- Existing sessions sort by their latest turn, else by when they began.
UPDATE "threads" SET "last_activity_at" = coalesce(
  (SELECT max("turns"."created_at") FROM "turns" WHERE "turns"."thread_id" = "threads"."id"),
  "threads"."created_at"
);

ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "parent_thread_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_parent_idx" ON "threads" USING btree ("parent_thread_id");

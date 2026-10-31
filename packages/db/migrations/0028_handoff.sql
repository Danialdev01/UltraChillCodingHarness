ALTER TABLE "threads" ADD COLUMN "tree_hash" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "handoff_from_thread_id" uuid;
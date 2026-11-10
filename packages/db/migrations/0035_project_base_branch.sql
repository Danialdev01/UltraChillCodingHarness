ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "auto_push_base" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "delete_branch_on_settle" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "settle_state" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "settle_error" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "settle_conflicts" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "settle_base_branch" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "merge_commit_sha" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone;
ALTER TABLE "threads" ADD COLUMN "hash" text;--> statement-breakpoint
UPDATE "threads" SET "hash" = substr(md5(random()::text || "id"::text), 1, 12);--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "worktree_state" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "worktree_error" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "hash" text;--> statement-breakpoint
UPDATE "workspaces" SET "hash" = substr(md5(random()::text || "id"::text), 1, 12);--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_hash_unique" UNIQUE("hash");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_hash_unique" UNIQUE("hash");

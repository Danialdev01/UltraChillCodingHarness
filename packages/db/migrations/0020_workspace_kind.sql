ALTER TABLE "workspaces" ADD COLUMN "kind" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "archived_at" timestamp with time zone;
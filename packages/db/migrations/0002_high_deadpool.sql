CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subagents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"model" text,
	"tool_preset" text DEFAULT 'standard' NOT NULL,
	"system_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagents" ADD CONSTRAINT "subagents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subagents_project_name_idx" ON "subagents" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "subagents_project_idx" ON "subagents" USING btree ("project_id");--> statement-breakpoint
-- Created before the backfill below, which relies on it for ON CONFLICT.
CREATE UNIQUE INDEX "workspaces_owner_slug_idx" ON "workspaces" USING btree ("owner_user_id","slug");--> statement-breakpoint
CREATE INDEX "workspaces_owner_idx" ON "workspaces" USING btree ("owner_user_id");--> statement-breakpoint
-- Projects predating workspaces need one to belong to. Add the column
-- nullable, give every existing owner a "Personal" workspace, backfill, then
-- enforce NOT NULL. Adding the column NOT NULL outright fails on a non-empty
-- table.
ALTER TABLE "projects" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
INSERT INTO "workspaces" ("slug", "name", "owner_user_id")
SELECT DISTINCT 'personal', 'Personal', "user_id" FROM "projects"
ON CONFLICT ("owner_user_id", "slug") DO NOTHING;--> statement-breakpoint
UPDATE "projects" SET "workspace_id" = w."id"
FROM "workspaces" w
WHERE w."owner_user_id" = "projects"."user_id"
  AND w."slug" = 'personal'
  AND "projects"."workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_workspace_idx" ON "projects" USING btree ("workspace_id");
CREATE TABLE "timeline_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"colour" text DEFAULT 'blue' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"depends_on_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timeline_tasks" ADD CONSTRAINT "timeline_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_tasks" ADD CONSTRAINT "timeline_tasks_depends_on_id_timeline_tasks_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."timeline_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timeline_tasks_project_idx" ON "timeline_tasks" USING btree ("project_id","position");
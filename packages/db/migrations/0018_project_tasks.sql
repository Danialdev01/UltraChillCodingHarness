CREATE TABLE "project_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage" text DEFAULT 'idea' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"position" real DEFAULT 0 NOT NULL,
	"research" text,
	"verification" jsonb,
	"feedback" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_agent_provider" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_agent_model" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_auto_run" jsonb;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_tasks_project_idx" ON "project_tasks" USING btree ("project_id","stage","position");
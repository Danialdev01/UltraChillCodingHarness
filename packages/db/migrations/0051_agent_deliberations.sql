CREATE TABLE "agent_deliberations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"turn_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"directive" jsonb,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deliberation" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_deliberations" ADD CONSTRAINT "agent_deliberations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_deliberations" ADD CONSTRAINT "agent_deliberations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_deliberations_thread_idx" ON "agent_deliberations" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_deliberations_project_idx" ON "agent_deliberations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_deliberations_running_idx" ON "agent_deliberations" USING btree ("status") WHERE status = 'running';
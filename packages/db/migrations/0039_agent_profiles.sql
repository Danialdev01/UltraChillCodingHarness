CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"context" text DEFAULT 'personal' NOT NULL,
	"dir_name" text NOT NULL,
	"auth_status" text DEFAULT 'unknown' NOT NULL,
	"limit_resets_at" timestamp with time zone,
	"limit_estimated" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_profile_defaults" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"profile_id" uuid NOT NULL,
	CONSTRAINT "project_profile_defaults_project_id_user_id_provider_pk" PRIMARY KEY("project_id","user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "required_context" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "project_profile_defaults" ADD CONSTRAINT "project_profile_defaults_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profile_defaults" ADD CONSTRAINT "project_profile_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profile_defaults" ADD CONSTRAINT "project_profile_defaults_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_label_idx" ON "agent_profiles" USING btree ("subject","provider","label");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_dir_idx" ON "agent_profiles" USING btree ("subject","dir_name");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_provider_check" CHECK ("provider" IN ('claude', 'codex'));--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_context_check" CHECK ("context" IN ('personal', 'work'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_required_context_check" CHECK ("required_context" IS NULL OR "required_context" IN ('personal', 'work'));

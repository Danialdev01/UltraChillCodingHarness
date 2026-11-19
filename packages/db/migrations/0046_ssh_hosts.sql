CREATE TABLE "ssh_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text NOT NULL,
	"auth_method" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"passphrase_encrypted" text,
	"host_key_sha256" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssh_hosts" ADD CONSTRAINT "ssh_hosts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_hosts" ADD CONSTRAINT "ssh_hosts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssh_hosts_workspace_idx" ON "ssh_hosts" USING btree ("workspace_id");
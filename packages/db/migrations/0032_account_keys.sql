CREATE TABLE "account_keys" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"prefix" text NOT NULL,
	"last4" text NOT NULL,
	"scopes" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_revealed_at" timestamp with time zone,
	CONSTRAINT "account_keys_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "step_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_keys" ADD CONSTRAINT "account_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
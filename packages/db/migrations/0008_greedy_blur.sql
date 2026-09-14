ALTER TABLE "threads" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "provider_session_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_provider" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "claude_oauth_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "claude_token_issued_at" timestamp with time zone;
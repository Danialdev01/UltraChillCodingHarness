ALTER TABLE "users" DROP COLUMN "claude_oauth_token_encrypted";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "claude_token_issued_at";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "claude_oauth_token_encrypted";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "claude_token_issued_at";
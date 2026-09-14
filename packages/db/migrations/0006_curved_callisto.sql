ALTER TABLE "projects" ALTER COLUMN "repo_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_token_encrypted" text;
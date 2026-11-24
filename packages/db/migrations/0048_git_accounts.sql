CREATE TABLE "git_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"login" text,
	"token_encrypted" text NOT NULL,
	"prefix" text NOT NULL,
	"last4" text NOT NULL,
	"scopes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "git_account_id" uuid;--> statement-breakpoint
ALTER TABLE "git_accounts" ADD CONSTRAINT "git_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_accounts_name_idx" ON "git_accounts" USING btree ("user_id","name");--> statement-breakpoint
-- The one GitHub token an account could keep becomes its first git account.
-- The ciphertext is bound to nothing but SECRET_KEY, so it moves as it is.
INSERT INTO "git_accounts" ("user_id", "provider", "name", "base_url", "token_encrypted", "prefix", "last4", "scopes", "created_at", "last_used_at")
SELECT u."id", 'github', 'GitHub', 'https://github.com', u."github_token_encrypted", coalesce(k."prefix", ''), coalesce(k."last4", ''), k."scopes", coalesce(k."created_at", now()), k."last_used_at"
FROM "users" u
LEFT JOIN "account_keys" k ON k."user_id" = u."id" AND k."provider" = 'github'
WHERE u."github_token_encrypted" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "github_token_encrypted" = NULL WHERE "github_token_encrypted" IS NOT NULL;--> statement-breakpoint
DELETE FROM "account_keys" WHERE "provider" = 'github';

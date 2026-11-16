ALTER TABLE "model_keys" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Each account's oldest OpenRouter key is its default until another is chosen.
UPDATE "model_keys" SET "is_default" = true
WHERE "id" IN (
	SELECT DISTINCT ON ("user_id") "id" FROM "model_keys"
	WHERE "kind" = 'openrouter'
	ORDER BY "user_id", "created_at" ASC
);

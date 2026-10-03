ALTER TABLE "projects" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "public_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_public_slug_unique" UNIQUE("public_slug");
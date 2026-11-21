ALTER TABLE "threads" ADD COLUMN "context_reading" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "session_prefix" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "idle_compact_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "resume_compact_prompt_off" boolean DEFAULT false NOT NULL;
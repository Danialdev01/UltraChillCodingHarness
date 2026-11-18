ALTER TABLE "projects" ADD COLUMN "session_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "used_at" timestamp with time zone;
--> statement-breakpoint
-- Preserve sessions used before activity markers existed. Old terminal audit
-- entries do not identify a worktree, so keep every session in those projects.
UPDATE "projects" SET "session_used_at" = now()
WHERE EXISTS (
  SELECT 1 FROM "audit_log" WHERE "audit_log"."project_id" = "projects"."id"
    AND "audit_log"."action" IN ('terminal.open', 'file.write', 'file.create', 'file.delete', 'file.rename')
);
--> statement-breakpoint
UPDATE "threads" SET "used_at" = now()
WHERE EXISTS (
  SELECT 1 FROM "projects" WHERE "projects"."id" = "threads"."project_id"
    AND "projects"."session_used_at" IS NOT NULL
);

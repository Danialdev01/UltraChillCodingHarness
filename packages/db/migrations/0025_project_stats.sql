CREATE TABLE "project_stats" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"thread_count" integer DEFAULT 0 NOT NULL,
	"tokens" double precision DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"last_turn_id" uuid,
	"last_turn_failed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_stats" ADD CONSTRAINT "project_stats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threads_running_idx" ON "threads" USING btree ("project_id") WHERE "threads"."status" = 'running';--> statement-breakpoint
-- Every existing project's totals, as listProjects summed them on each
-- bootstrap until now. The same query as recomputeProjectStats
-- (apps/server/src/project-stats.ts); the stop reasons are LIMIT_STOP_REASONS
-- (packages/protocol/src/events.ts), and a test keeps the two lists equal.
-- Migrations run at boot before anything is served, so nothing writes
-- turns meanwhile.
INSERT INTO "project_stats" ("project_id", "thread_count", "tokens", "cost_usd", "last_turn_id", "last_turn_failed")
SELECT
	p.id,
	(SELECT count(*)::int FROM "threads" th WHERE th.project_id = p.id),
	(
		SELECT coalesce(sum(
			(tu.usage ->> 'inputTokens')::double precision
			+ (tu.usage ->> 'outputTokens')::double precision
			+ (tu.usage ->> 'cacheReadInputTokens')::double precision
			+ (tu.usage ->> 'cacheCreationInputTokens')::double precision
		), 0)
		FROM "turns" tu JOIN "threads" th ON th.id = tu.thread_id
		WHERE th.project_id = p.id
	),
	(
		SELECT coalesce(sum(tu.cost_usd)::double precision, 0)
		FROM "turns" tu JOIN "threads" th ON th.id = tu.thread_id
		WHERE th.project_id = p.id
	),
	last.id,
	coalesce(
		last.error IS NOT NULL OR last.stop_reason IN ('max_iterations', 'max_tokens', 'length') OR last.stop_reason LIKE 'error%',
		false
	)
FROM "projects" p
LEFT JOIN LATERAL (
	SELECT tu.id, tu.error, tu.stop_reason
	FROM "turns" tu JOIN "threads" th ON th.id = tu.thread_id
	WHERE th.project_id = p.id
	ORDER BY tu.created_at DESC
	LIMIT 1
) last ON true;

-- Project-scoped events (thread_id is null) had no unique sequence: two
-- writers outside the engine could both take max(seq) + 1, and the browser,
-- which dedupes on (project, seq), dropped one of them. Renumber each
-- project's stream in insertion order before the index becomes unique.
-- Only thread topics replay from the log. A row's new number is the count
-- of rows inserted before it, never less than the max(seq) + 1 it was given
-- from the rows it could see, so the stream's maximum does not go down and
-- new events keep numbers above any a client has seen.
WITH r AS (
	SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY id) - 1 AS s
	FROM "events" WHERE thread_id IS NULL
)
UPDATE "events" e SET seq = r.s FROM r WHERE e.id = r.id AND e.seq <> r.s;--> statement-breakpoint
DROP INDEX "events_project_seq_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "events_project_seq_idx" ON "events" USING btree ("project_id","seq") WHERE "events"."thread_id" is null;

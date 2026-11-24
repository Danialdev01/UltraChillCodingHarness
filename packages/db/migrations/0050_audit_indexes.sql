DROP INDEX "subagents_project_idx";--> statement-breakpoint
DROP INDEX "threads_project_idx";--> statement-breakpoint
CREATE INDEX "agent_messages_from_idx" ON "agent_messages" USING btree ("from_thread_id");--> statement-breakpoint
CREATE INDEX "agent_runs_child_idx" ON "agent_runs" USING btree ("child_thread_id");
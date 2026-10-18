DROP INDEX "events_type_idx";--> statement-breakpoint
CREATE INDEX "audit_log_project_id_idx" ON "audit_log" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "events_project_seq_idx" ON "events" USING btree ("project_id","seq") WHERE "events"."thread_id" is null;--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "threads_project_created_idx" ON "threads" USING btree ("project_id","created_at");
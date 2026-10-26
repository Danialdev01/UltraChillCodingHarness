-- A note's collaborative document: the Yjs state the collab service keeps,
-- from which notes.content is projected on every save.
CREATE TABLE "note_ydocs" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_ydocs" ADD CONSTRAINT "note_ydocs_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;
CREATE TABLE IF NOT EXISTS "message_read_cursors" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_through" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_read_cursors_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_read_cursors" ADD CONSTRAINT "message_read_cursors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_read_cursors" ADD CONSTRAINT "message_read_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

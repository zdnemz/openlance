CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_user_type_idx" ON "notification_preferences" USING btree ("user_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_recipients_event_user_idx" ON "notification_recipients" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE INDEX "notification_recipients_user_created_idx" ON "notification_recipients" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_recipients_user_unread_idx" ON "notification_recipients" USING btree ("user_id","read_at");
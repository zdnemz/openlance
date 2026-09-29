CREATE TABLE "sponsorship_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signature" text NOT NULL,
	"registered_onchain" boolean DEFAULT false NOT NULL,
	"sponsored_tx_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sponsorship_sessions" ADD CONSTRAINT "sponsorship_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sponsorship_sessions_user_idx" ON "sponsorship_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sponsorship_sessions_expires_idx" ON "sponsorship_sessions" USING btree ("expires_at");
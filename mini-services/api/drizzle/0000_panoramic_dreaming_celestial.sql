CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dispute_outcome" AS ENUM('release', 'refund', 'split');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'agreed', 'assigned', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('open', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."milestone_chain_status" AS ENUM('pending_funding', 'funded', 'submitted', 'released', 'disputed', 'resolved_release', 'resolved_refund', 'resolved_split', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('submitted', 'accepted', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."submission_soft_status" AS ENUM('submitted', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('client', 'freelancer', 'both');--> statement-breakpoint
CREATE TABLE "arbiters" (
	"address" text PRIMARY KEY NOT NULL,
	"registered" boolean DEFAULT true NOT NULL,
	"sbt_token_id" bigint,
	"trust_score" integer DEFAULT 0 NOT NULL,
	"resolutions" integer DEFAULT 0 NOT NULL,
	"resolutions_within_sla" integer DEFAULT 0 NOT NULL,
	"resolutions_late" integer DEFAULT 0 NOT NULL,
	"registered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_driver" text NOT NULL,
	"storage_path" text NOT NULL,
	"status" "attachment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"opened_by_id" uuid NOT NULL,
	"reason" text,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"client_proposed_arbiter" text,
	"freelancer_proposed_arbiter" text,
	"agreed_arbiter" text,
	"admin_assigned_arbiter" text,
	"agreement_deadline" timestamp with time zone NOT NULL,
	"resolved_arbiter" text,
	"outcome" "dispute_outcome",
	"resolution_tx_hash" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_milestone_id_unique" UNIQUE("milestone_id")
);
--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_block" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"amount_wei" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poster_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"budget_min_wei" numeric(78, 0) NOT NULL,
	"budget_max_wei" numeric(78, 0) NOT NULL,
	"status" "job_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"contract_address" text NOT NULL,
	"event_type" text NOT NULL,
	"milestone_onchain_id" bigint,
	"project_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"actor_address" text,
	"project_id" uuid,
	"milestone_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"amount_wei" numeric(78, 0) NOT NULL,
	"onchain_id" bigint,
	"chain_status" "milestone_chain_status" DEFAULT 'pending_funding' NOT NULL,
	"funded_tx_hash" text,
	"funded_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"settlement_tx_hash" text,
	"soft_status" "submission_soft_status",
	"soft_status_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_milestones_onchain_id_unique" UNIQUE("onchain_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"freelancer_id" uuid NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "projects_proposal_id_unique" UNIQUE("proposal_id")
);
--> statement-breakpoint
CREATE TABLE "proposal_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"amount_wei" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"freelancer_id" uuid NOT NULL,
	"cover_note" text NOT NULL,
	"bid_total_wei" numeric(78, 0) NOT NULL,
	"delivery_days" integer NOT NULL,
	"status" "proposal_status" DEFAULT 'submitted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"checked" integer DEFAULT 0 NOT NULL,
	"drifts" integer DEFAULT 0 NOT NULL,
	"report" jsonb
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"reviewee_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"body" text,
	"tx_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_attachments" (
	"submission_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"notes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"role" "user_role" DEFAULT 'both' NOT NULL,
	"is_arbiter" boolean DEFAULT false NOT NULL,
	"total_earned_wei" numeric(78, 0) DEFAULT '0' NOT NULL,
	"total_paid_wei" numeric(78, 0) DEFAULT '0' NOT NULL,
	"completed_projects_as_client" integer DEFAULT 0 NOT NULL,
	"completed_projects_as_freelancer" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_milestones" ADD CONSTRAINT "job_milestones_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_poster_id_users_id_fk" FOREIGN KEY ("poster_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_freelancer_id_users_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_milestones" ADD CONSTRAINT "proposal_milestones_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_freelancer_id_users_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewee_id_users_id_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_attachments" ADD CONSTRAINT "submission_attachments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_attachments" ADD CONSTRAINT "submission_attachments_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_project_idx" ON "attachments" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_milestones_job_position_idx" ON "job_milestones" USING btree ("job_id","position");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_category_idx" ON "jobs" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_log_idx" ON "ledger_events" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "ledger_project_idx" ON "ledger_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ledger_type_idx" ON "ledger_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "messages_project_created_idx" ON "messages" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_events_created_idx" ON "notification_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_milestones_position_idx" ON "project_milestones" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_milestones_position_idx" ON "proposal_milestones" USING btree ("proposal_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_job_freelancer_idx" ON "proposals" USING btree ("job_id","freelancer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_milestone_reviewer_idx" ON "reviews" USING btree ("milestone_id","reviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_attachment_idx" ON "submission_attachments" USING btree ("submission_id","attachment_id");--> statement-breakpoint
CREATE INDEX "submissions_milestone_idx" ON "submissions" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_sub_idx" ON "webhook_deliveries" USING btree ("subscription_id","created_at");
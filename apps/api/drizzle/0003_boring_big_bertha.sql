ALTER TYPE "public"."job_status" ADD VALUE 'draft' BEFORE 'open';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deposit_amount_wei" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deposit_tx_hash" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deposited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD COLUMN "withdraw_tx_hash" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "arbiter_proposal" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "chosen_arbiters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "arbiters_locked_at" timestamp with time zone;
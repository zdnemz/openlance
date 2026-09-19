CREATE TYPE "public"."dispute_phase" AS ENUM('none', 'commit', 'reveal', 'resolved');--> statement-breakpoint
ALTER TABLE "arbiters" ADD COLUMN "stake_wei" numeric(78, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "arbiters" ADD COLUMN "unstake_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "arbiters" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "phase" "dispute_phase" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "selected_arbiters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "commit_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "reveal_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "appeal_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "tally" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "revealed_arbiters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "committed_arbiters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "finalized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "majority_arbiters" jsonb DEFAULT '[]'::jsonb NOT NULL;
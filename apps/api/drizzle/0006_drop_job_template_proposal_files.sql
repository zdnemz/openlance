ALTER TABLE "job_milestones" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "job_milestones" CASCADE;--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "budget_min_wei" SET DEFAULT '0'::numeric;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_proposal_idx" ON "attachments" USING btree ("proposal_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_single_owner" CHECK (num_nonnulls("attachments"."project_id", "attachments"."proposal_id") = 1);
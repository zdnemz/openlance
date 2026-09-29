DROP INDEX "submission_attachment_idx";--> statement-breakpoint
ALTER TABLE "submission_attachments" ADD CONSTRAINT "submission_attachments_submission_id_attachment_id_pk" PRIMARY KEY("submission_id","attachment_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_uploader_idx" ON "attachments" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "disputes_project_idx" ON "disputes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "disputes_opened_by_idx" ON "disputes" USING btree ("opened_by_id");--> statement-breakpoint
CREATE INDEX "disputes_sla_scan_idx" ON "disputes" USING btree ("status","reveal_deadline");--> statement-breakpoint
CREATE INDEX "jobs_poster_idx" ON "jobs" USING btree ("poster_id");--> statement-breakpoint
CREATE INDEX "ledger_chain_block_idx" ON "ledger_events" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "messages_attachment_idx" ON "messages" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "notification_events_milestone_type_idx" ON "notification_events" USING btree ("milestone_id","type");--> statement-breakpoint
CREATE INDEX "projects_client_idx" ON "projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "projects_freelancer_idx" ON "projects" USING btree ("freelancer_id");--> statement-breakpoint
CREATE INDEX "proposals_job_idx" ON "proposals" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "proposals_freelancer_idx" ON "proposals" USING btree ("freelancer_id");--> statement-breakpoint
CREATE INDEX "reviews_reviewer_idx" ON "reviews" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "reviews_reviewee_created_idx" ON "reviews" USING btree ("reviewee_id","created_at");--> statement-breakpoint
CREATE INDEX "submission_attachments_attachment_idx" ON "submission_attachments" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "submissions_author_idx" ON "submissions" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_active_idx" ON "webhook_subscriptions" USING btree ("active");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_user_idx" ON "webhook_subscriptions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN "client_proposed_arbiter";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN "freelancer_proposed_arbiter";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN "agreed_arbiter";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN "admin_assigned_arbiter";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN "agreement_deadline";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_storage_path_present" CHECK (length("attachments"."storage_path") > 0);--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_round_nonneg" CHECK ("disputes"."round" >= 0);--> statement-breakpoint
ALTER TABLE "job_milestones" ADD CONSTRAINT "job_milestones_amount_nonneg" CHECK ("job_milestones"."amount_wei" >= 0);--> statement-breakpoint
ALTER TABLE "job_milestones" ADD CONSTRAINT "job_milestones_position_nonneg" CHECK ("job_milestones"."position" >= 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_budget_nonneg" CHECK ("jobs"."budget_min_wei" >= 0 and "jobs"."budget_max_wei" >= 0 and "jobs"."deposit_amount_wei" >= 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_budget_ordered" CHECK ("jobs"."budget_max_wei" >= "jobs"."budget_min_wei");--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_amount_nonneg" CHECK ("project_milestones"."amount_wei" >= 0);--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_position_nonneg" CHECK ("project_milestones"."position" >= 0);--> statement-breakpoint
ALTER TABLE "proposal_milestones" ADD CONSTRAINT "proposal_milestones_amount_nonneg" CHECK ("proposal_milestones"."amount_wei" >= 0);--> statement-breakpoint
ALTER TABLE "proposal_milestones" ADD CONSTRAINT "proposal_milestones_position_nonneg" CHECK ("proposal_milestones"."position" >= 0);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_bid_nonneg" CHECK ("proposals"."bid_total_wei" >= 0);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_delivery_days_positive" CHECK ("proposals"."delivery_days" > 0);--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_totals_nonneg" CHECK ("users"."total_earned_wei" >= 0 and "users"."total_paid_wei" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_completed_nonneg" CHECK ("users"."completed_projects_as_client" >= 0 and "users"."completed_projects_as_freelancer" >= 0);
-- One LIVE proposal per freelancer per job (PRD F2).
--
-- The index was unconditional, so a freelancer who WITHDREW their bid kept
-- occupying the slot permanently: the job page offered the propose form again
-- (it filtered `status !== "withdrawn"`) and every resubmit failed 409
-- duplicate_proposal with no way forward. A partial index over the live
-- statuses makes a withdrawn or rejected row history rather than a claim, so
-- the slot frees up and a fresh bid is a new row.
--
-- Written by hand rather than generated: drizzle-kit emits bind parameters
-- (`IN ($1, $2)`), which are not valid in a DDL statement.
DROP INDEX IF EXISTS "proposals_job_freelancer_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_job_freelancer_idx" ON "proposals" USING btree ("job_id","freelancer_id") WHERE "status" IN ('submitted', 'accepted');

DROP TABLE "arbiters" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "arbiter_tier";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_arbiter";
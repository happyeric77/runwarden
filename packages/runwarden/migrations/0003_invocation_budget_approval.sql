ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "pending_budget_request" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "budget_grants" jsonb;
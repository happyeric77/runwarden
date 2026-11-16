ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "cost_usd" numeric(30, 12);--> statement-breakpoint
ALTER TABLE "agent_runtime"."invocations" ADD COLUMN "usage_steps" jsonb;
CREATE SCHEMA IF NOT EXISTS "agent_runtime";
--> statement-breakpoint
CREATE TYPE "agent_runtime"."invocation_status" AS ENUM('pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "agent_runtime"."tool_call_status" AS ENUM('started', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "agent_runtime"."invocations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_runtime"."invocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" text NOT NULL,
	"conversation_id" text,
	"ordering_key" text,
	"input" jsonb NOT NULL,
	"result_text" text,
	"idempotency_key" text,
	"status" "agent_runtime"."invocation_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"lease_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"active_run_id" uuid,
	"active_run_registered_at" timestamp with time zone,
	"pending_tool_call" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"provider" text,
	"model" text,
	"last_error_code" text,
	"last_error_message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."policy_decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_runtime"."policy_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" text NOT NULL,
	"invocation_id" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_name" text,
	"rule" text NOT NULL,
	"decision" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."tool_call_audits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_runtime"."tool_call_audits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"invocation_id" bigint NOT NULL,
	"scope" text NOT NULL,
	"run_id" uuid,
	"tool_name" text NOT NULL,
	"idempotency_key" text,
	"status" "agent_runtime"."tool_call_status" NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"request_snapshot" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runtime"."worker_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runtime"."policy_decisions" ADD CONSTRAINT "policy_decisions_invocation_id_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "agent_runtime"."invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime"."tool_call_audits" ADD CONSTRAINT "tool_call_audits_invocation_id_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "agent_runtime"."invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invocations_scope_idempotency_key_unique" ON "agent_runtime"."invocations" USING btree ("scope","idempotency_key") WHERE "agent_runtime"."invocations"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invocations_active_run_id_unique" ON "agent_runtime"."invocations" USING btree ("active_run_id") WHERE "agent_runtime"."invocations"."active_run_id" is not null;--> statement-breakpoint
CREATE INDEX "invocations_status_next_attempt_idx" ON "agent_runtime"."invocations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "invocations_status_lease_expires_idx" ON "agent_runtime"."invocations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "invocations_scope_status_next_attempt_idx" ON "agent_runtime"."invocations" USING btree ("scope","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "invocations_scope_created_idx" ON "agent_runtime"."invocations" USING btree ("scope","created_at");--> statement-breakpoint
CREATE INDEX "policy_decisions_invocation_idx" ON "agent_runtime"."policy_decisions" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "policy_decisions_run_idx" ON "agent_runtime"."policy_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_audits_scope_tool_idempotency_unique" ON "agent_runtime"."tool_call_audits" USING btree ("scope","tool_name","idempotency_key") WHERE "agent_runtime"."tool_call_audits"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "tool_call_audits_invocation_idx" ON "agent_runtime"."tool_call_audits" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "tool_call_audits_run_idx" ON "agent_runtime"."tool_call_audits" USING btree ("run_id");
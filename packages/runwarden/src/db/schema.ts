import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { PolicyDecisionKind, PolicyRule } from '../contracts/policy.js';
import type {
  InvocationInput,
  InvocationStatus,
} from '../contracts/runtime.js';

export const runtimeSchema = pgSchema('agent_runtime');

export const invocationStatusEnum = runtimeSchema.enum('invocation_status', [
  'pending',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
]);

export const toolCallStatusEnum = runtimeSchema.enum('tool_call_status', [
  'started',
  'succeeded',
  'failed',
]);

export type ToolCallStatus = (typeof toolCallStatusEnum.enumValues)[number];

// Column builders cannot be shared across tables; build fresh ones per table.
const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow();

const timestamps = () => ({
  createdAt: createdAtColumn(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const invocations = runtimeSchema.table(
  'invocations',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    scope: text('scope').notNull(),
    conversationId: text('conversation_id'),
    orderingKey: text('ordering_key'),
    input: jsonb('input').$type<InvocationInput>().notNull(),
    resultText: text('result_text'),
    idempotencyKey: text('idempotency_key'),
    status: invocationStatusEnum('status')
      .notNull()
      .default('pending')
      .$type<InvocationStatus>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
    claimedBy: text('claimed_by'),
    leaseHeartbeatAt: timestamp('lease_heartbeat_at', {
      withTimezone: true,
      mode: 'date',
    }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // Kept after terminal marks: it is the run id invoke() reports.
    activeRunId: uuid('active_run_id'),
    activeRunRegisteredAt: timestamp('active_run_registered_at', {
      withTimezone: true,
      mode: 'date',
    }),
    pendingToolCall: jsonb('pending_tool_call'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    provider: text('provider'),
    model: text('model'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('invocations_scope_idempotency_key_unique')
      .on(table.scope, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex('invocations_active_run_id_unique')
      .on(table.activeRunId)
      .where(sql`${table.activeRunId} is not null`),
    index('invocations_status_next_attempt_idx').on(
      table.status,
      table.nextAttemptAt,
    ),
    index('invocations_status_lease_expires_idx').on(
      table.status,
      table.leaseExpiresAt,
    ),
    index('invocations_scope_status_next_attempt_idx').on(
      table.scope,
      table.status,
      table.nextAttemptAt,
    ),
    index('invocations_scope_created_idx').on(table.scope, table.createdAt),
  ],
);

export const toolCallAudits = runtimeSchema.table(
  'tool_call_audits',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    invocationId: bigint('invocation_id', { mode: 'number' })
      .notNull()
      .references(() => invocations.id),
    scope: text('scope').notNull(),
    runId: uuid('run_id'),
    toolName: text('tool_name').notNull(),
    idempotencyKey: text('idempotency_key'),
    status: toolCallStatusEnum('status').notNull(),
    requestedAt: timestamp('requested_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    errorCode: text('error_code'),
    requestSnapshot: jsonb('request_snapshot'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('tool_call_audits_scope_tool_idempotency_unique')
      .on(table.scope, table.toolName, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('tool_call_audits_invocation_idx').on(table.invocationId),
    index('tool_call_audits_run_idx').on(table.runId),
  ],
);

export const policyDecisions = runtimeSchema.table(
  'policy_decisions',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    scope: text('scope').notNull(),
    invocationId: bigint('invocation_id', { mode: 'number' })
      .notNull()
      .references(() => invocations.id),
    runId: uuid('run_id').notNull(),
    toolName: text('tool_name'),
    rule: text('rule').$type<PolicyRule>().notNull(),
    decision: text('decision').$type<PolicyDecisionKind>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('policy_decisions_invocation_idx').on(table.invocationId),
    index('policy_decisions_run_idx').on(table.runId),
  ],
);

export const workerLeases = runtimeSchema.table('worker_leases', {
  name: text('name').primaryKey(),
  holderId: text('holder_id').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
});

export type InvocationRow = typeof invocations.$inferSelect;
export type PolicyDecisionRow = typeof policyDecisions.$inferSelect;

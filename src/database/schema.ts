import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    eventType: text('event_type'),
    payloadRaw: text('payload_raw').notNull(),
    payloadRawHash: text('payload_raw_hash').notNull(),
    eventFingerprint: text('event_fingerprint').notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('events_event_fingerprint_unique').on(table.eventFingerprint),
    index('events_received_at_index').on(table.receivedAt),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'processing', 'completed', 'failed'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: integer('available_at', { mode: 'timestamp_ms' }).notNull(),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    lockedBy: text('locked_by'),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    result: text('result'),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('tasks_claim_index').on(table.status, table.availableAt, table.id)],
);

export type Task = typeof tasks.$inferSelect;

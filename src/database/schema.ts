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

export const serviceConnections = sqliteTable(
  'service_connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    service: text('service', { enum: ['radarr', 'seerr'] }).notNull(),
    alias: text('alias').notNull().default('default'),
    baseUrl: text('base_url').notNull(),
    secretRef: text('secret_ref').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    connectionStatus: text('connection_status').notNull().default('untested'),
    version: text('version'),
    instanceName: text('instance_name'),
    lastTestedAt: integer('last_tested_at', { mode: 'timestamp_ms' }),
    lastSuccessfulTestAt: integer('last_successful_test_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('service_connections_service_url_unique').on(table.service, table.baseUrl),
    index('service_connections_active_index').on(table.service, table.isActive),
  ],
);

export const encryptedSecrets = sqliteTable('encrypted_secrets', {
  id: text('id').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const installationDiagnostics = sqliteTable('installation_diagnostics', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  status: text('status').notNull(),
  radarrConnectionId: integer('radarr_connection_id').notNull(),
  seerrConnectionId: integer('seerr_connection_id').notNull(),
  selectedSeerrRadarrId: integer('selected_seerr_radarr_id'),
  resultJson: text('result_json').notNull(),
  configurationFingerprint: text('configuration_fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export const installationSnapshots = sqliteTable('installation_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: integer('version').notNull().default(1),
  diagnosticId: integer('diagnostic_id').notNull(),
  state: text('state').notNull().default('valid'),
  snapshotJson: text('snapshot_json').notNull(),
  configurationFingerprint: text('configuration_fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }),
  rolledBackAt: integer('rolled_back_at', { mode: 'timestamp_ms' }),
});

export const managedResources = sqliteTable(
  'managed_resources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    snapshotId: integer('snapshot_id').notNull(),
    service: text('service').notNull(),
    resourceType: text('resource_type').notNull(),
    externalId: text('external_id').notNull(),
    marker: text('marker').notNull(),
    createdByScorerr: integer('created_by_scorerr', { mode: 'boolean' }).notNull(),
    expectedStateJson: text('expected_state_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('managed_resources_lookup_index').on(table.service, table.resourceType)],
);

export const installationOperations = sqliteTable('installation_operations', {
  id: text('id').primaryKey(),
  action: text('action').notNull(),
  status: text('status').notNull(),
  reportJson: text('report_json'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export const installationAuditLog = sqliteTable('installation_audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  operationId: text('operation_id').notNull(),
  action: text('action').notNull(),
  service: text('service'),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  result: text('result').notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const installationProbeReports = sqliteTable('installation_probe_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: integer('version').notNull().default(1),
  reportJson: text('report_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

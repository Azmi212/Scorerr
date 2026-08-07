/* eslint-disable @typescript-eslint/require-await */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/api/app.js';
import {
  buildWebhookPayload,
  classifyScorerrWebhook,
  parseNotifications,
} from '../src/adapters/radarr-adapter.js';
import { buildSeerrUpdate, parseSeerrInstances } from '../src/adapters/seerr-adapter.js';
import type { AppConfig } from '../src/config/env.js';
import { createDatabase, type DatabaseContext } from '../src/database/client.js';
import { applyMigrations } from '../src/database/migrate.js';
import { SqliteSecretStore } from '../src/security/secret-store.js';
import { ServiceClientError } from '../src/security/redaction.js';
import { InstallationService, type ClientFactory } from '../src/services/installation-service.js';

const webhookSchema = [
  {
    name: '',
    implementation: 'Webhook',
    configContract: 'WebhookSettings',
    infoLink: 'https://wiki.servarr.com/radarr/supported#webhook',
    onGrab: false,
    onDownload: false,
    onUpgrade: false,
    onRename: false,
    onMovieAdded: false,
    supportsOnMovieAdded: true,
    onMovieDelete: false,
    onMovieFileDelete: false,
    onMovieFileDeleteForUpgrade: false,
    onHealthIssue: false,
    onHealthRestored: false,
    onApplicationUpdate: false,
    supportsOnApplicationUpdate: true,
    tags: [],
    fields: [
      { name: 'url', value: '' },
      { name: 'method', value: 1 },
      { name: 'username', value: '' },
      { name: 'password', value: '' },
      { name: 'headers', value: [] },
    ],
  },
];
const radarrStatus = { version: '6.2.1.10461', instanceName: 'Main Radarr' };

interface State {
  radarrKey: string;
  seerrKey: string;
  unavailable?: boolean;
  notifications: Record<string, unknown>[];
  instances: Record<string, unknown>[];
  created: number;
  deleted: number;
  schemaMissing?: boolean;
}

function initialState(): State {
  return {
    radarrKey: 'radarr-super-secret',
    seerrKey: 'seerr-super-secret',
    notifications: [],
    instances: [
      {
        id: 4,
        name: 'Main',
        hostname: 'radarr',
        port: 7878,
        apiKey: 'nested-radarr-secret',
        useSsl: false,
        baseUrl: '',
        active: true,
        is4k: false,
        preventSearch: false,
      },
    ],
    created: 0,
    deleted: 0,
  };
}

function factory(state: State): ClientFactory {
  return {
    radarr: (_url, key) =>
      ({
        status: async () => {
          if (state.unavailable) throw new Error('offline');
          if (key !== state.radarrKey)
            throw Object.assign(new Error('bad key'), {
              code: 'unauthorized',
              safeMessage: 'Authentication was rejected',
            });
          return radarrStatus;
        },
        notifications: async () => state.notifications,
        notificationSchemas: async () => {
          if (state.schemaMissing)
            throw new ServiceClientError('not_found', 'Service endpoint was not found', 404);
          return webhookSchema;
        },
        createNotification: async (payload: unknown) => {
          state.created++;
          const body = payload as Record<string, unknown>;
          state.notifications.push({ ...body, id: 80 });
          return { id: 80 };
        },
        deleteNotification: async (id: number) => {
          state.deleted++;
          state.notifications = state.notifications.filter((item) => item.id !== id);
          return null;
        },
        testNotification: async () => ({ isValid: true }),
      }) as never,
    seerr: (_url, key) =>
      ({
        radarrSettings: async () => {
          if (key !== state.seerrKey)
            throw Object.assign(new Error('bad key'), {
              code: 'unauthorized',
              safeMessage: 'Authentication was rejected',
            });
          return state.instances;
        },
        publicSettings: async () => ({ version: '2.4.0' }),
        status: async () => ({ version: '2.7.3' }),
        updateRadarr: async (id: number, payload: unknown) => {
          const current = state.instances.find((item) => item.id === id);
          if (!current) throw new Error('missing');
          state.instances = state.instances.map((item) =>
            item.id === id ? { ...item, ...(payload as object) } : item,
          );
          return current;
        },
      }) as never,
  };
}

interface SetupContext {
  app: ReturnType<typeof buildApp>;
  database: DatabaseContext;
  state: State;
  directory: string;
  cleanup(): Promise<void>;
}
function context(overrides: Partial<AppConfig> = {}, state = initialState()): SetupContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-installer-'));
  const dbPath = path.join(directory, 'test.db');
  const database = createDatabase(dbPath);
  applyMigrations(database);
  const config: AppConfig = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    DATABASE_PATH: dbPath,
    LOG_LEVEL: 'silent',
    BODY_LIMIT_BYTES: 1024 * 1024,
    SCORERR_PUBLIC_URL: 'http://scorerr:3000',
    HTTP_TIMEOUT_MS: 100,
    HTTP_MAX_RESPONSE_BYTES: 1024 * 1024,
    SETUP_DIAGNOSTIC_TTL_MS: 300_000,
    SETUP_WRITES_ENABLED: true,
    SETUP_NON_PERSISTENT_TESTS_ENABLED: false,
    WORKER_POLL_INTERVAL_MS: 100,
    WORKER_SCHEMA_WAIT_INTERVAL_MS: 100,
    WORKER_LOCK_TIMEOUT_MS: 300_000,
    WORKER_MAX_ATTEMPTS: 3,
    ...overrides,
  };
  const secrets = new SqliteSecretStore(database, dbPath, config.SCORERR_MASTER_KEY);
  const service = new InstallationService(database, config, secrets, factory(state));
  const app = buildApp({ config, database, installationService: service });
  return {
    app,
    database,
    state,
    directory,
    cleanup: async () => {
      await app.close();
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function connect(ctx: SetupContext): Promise<void> {
  const connections: [string, string, string][] = [
    ['radarr', 'http://radarr:7878', ctx.state.radarrKey],
    ['seerr', 'http://seerr:5055', ctx.state.seerrKey],
  ];
  for (const [service, url, apiKey] of connections) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/setup/${service}/test`,
      payload: { baseUrl: url, apiKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(apiKey);
  }
}

describe('scorerr installer', () => {
  let ctx: SetupContext | undefined;
  afterEach(async () => ctx?.cleanup());
  it('serves the local-only setup interface without keys', async () => {
    ctx = context();
    const response = await ctx.app.inject({ url: '/setup' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('scorerr installer');
    expect(response.body).not.toContain(ctx.state.radarrKey);
  });
  it('recognizes a preexisting compatible webhook with an extra trigger', () => {
    const notifications = parseNotifications([
      {
        id: 42,
        name: 'Existing webhook',
        implementation: 'Webhook',
        configContract: 'WebhookSettings',
        onMovieAdded: true,
        supportsOnMovieAdded: true,
        onMovieFileDeleteForUpgrade: true,
        fields: [{ name: 'url', value: 'http://scorerr:3000/api/webhooks/radarr' }],
      },
    ]);
    expect(
      classifyScorerrWebhook(notifications, 'http://scorerr:3000/api/webhooks/radarr', new Set()),
    ).toMatchObject({
      state: 'preexisting_compatible_extra_triggers',
      extraTriggers: ['onMovieFileDeleteForUpgrade'],
    });
  });
  it('builds the exact observed Radarr Webhook payload without inventing fields', () => {
    const payload = buildWebhookPayload(webhookSchema, 'http://scorerr:3000/api/webhooks/radarr');
    expect(payload).toEqual({
      ...webhookSchema[0],
      name: 'scorerr-movie-added',
      onMovieAdded: true,
      fields: [
        { name: 'url', value: 'http://scorerr:3000/api/webhooks/radarr' },
        { name: 'method', value: 1 },
        { name: 'username', value: '' },
        { name: 'password', value: '' },
        { name: 'headers', value: [] },
      ],
    });
    expect(payload.onMovieFileDeleteForUpgrade).toBe(false);
  });
  it('builds the documented Seerr PUT payload and excludes observed GET-only tags', () => {
    const [instance] = parseSeerrInstances([
      {
        id: 4,
        name: 'Main',
        hostname: 'radarr',
        port: 7878,
        apiKey: 'secret',
        useSsl: false,
        baseUrl: '/radarr',
        activeProfileId: 6,
        activeProfileName: 'HD',
        activeDirectory: '/movies',
        is4k: false,
        minimumAvailability: 'released',
        isDefault: true,
        externalUrl: 'https://radarr.example',
        syncEnabled: true,
        preventSearch: false,
        tags: [1],
        tagRequests: true,
      },
    ]);
    if (!instance) throw new Error('Expected Seerr fixture');
    expect(buildSeerrUpdate(instance, true)).toEqual({
      name: 'Main',
      hostname: 'radarr',
      port: 7878,
      apiKey: 'secret',
      useSsl: false,
      baseUrl: '/radarr',
      activeProfileId: 6,
      activeProfileName: 'HD',
      activeDirectory: '/movies',
      is4k: false,
      minimumAvailability: 'released',
      isDefault: true,
      externalUrl: 'https://radarr.example',
      syncEnabled: true,
      preventSearch: true,
    });
  });
  it('tests connections and never returns or stores plaintext keys', async () => {
    ctx = context();
    await connect(ctx);
    const dump = fs.readFileSync(path.join(ctx.directory, 'test.db'));
    expect(dump.includes(Buffer.from(ctx.state.radarrKey))).toBe(false);
    expect(
      ctx.database.sqlite.prepare('SELECT ciphertext FROM encrypted_secrets').all(),
    ).not.toContain(ctx.state.radarrKey);
  });
  it('rejects an invalid API key without leaking it', async () => {
    ctx = context();
    const key = 'wrong-secret-key';
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup/radarr/test',
      payload: { baseUrl: 'http://radarr:7878', apiKey: key },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain(key);
  });
  it('requires selection when Seerr has multiple non-matching instances', async () => {
    const state = initialState();
    state.instances.push({ ...state.instances[0], id: 5, name: 'Other', hostname: 'other-radarr' });
    state.instances[0] = { ...state.instances[0], hostname: 'first-radarr' };
    ctx = context({}, state);
    await connect(ctx);
    const response = await ctx.app.inject({ url: '/api/setup/diagnostic' });
    expect(response.json()).toMatchObject({
      status: 'selection_required',
      seerr: { radarrInstanceFound: false },
    });
  });
  it('diagnoses callback, missing webhook, and preventSearch', async () => {
    ctx = context();
    await connect(ctx);
    const response = await ctx.app.inject({ url: '/api/setup/diagnostic' });
    expect(response.json()).toMatchObject({
      status: 'ready',
      callbackUrl: 'http://scorerr:3000/api/webhooks/radarr',
      radarr: { webhookPresent: false },
      seerr: { preventSearch: false },
      ready: true,
    });
  });
  it('applies in Radarr-then-Seerr order and is idempotent', async () => {
    ctx = context();
    await connect(ctx);
    await ctx.app.inject({ url: '/api/setup/diagnostic' });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/snapshot', payload: {} });
    const first = await ctx.app.inject({ method: 'POST', url: '/api/setup/apply', payload: {} });
    expect(first.json()).toMatchObject({
      status: 'operational',
      webhook: 'created',
      seerr: 'updated',
    });
    expect(ctx.state.instances[0]?.preventSearch).toBe(true);
    const second = await ctx.app.inject({ method: 'POST', url: '/api/setup/apply', payload: {} });
    expect(second.json()).toMatchObject({
      webhook: 'already_configured',
      seerr: 'already_configured',
    });
    expect(ctx.state.created).toBe(1);
    const repeatedSnapshot = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup/snapshot',
      payload: {},
    });
    expect(repeatedSnapshot.json()).toMatchObject({ reused: true });
    expect(
      ctx.database.sqlite.prepare('SELECT COUNT(*) AS count FROM installation_snapshots').get(),
    ).toEqual({ count: 1 });
  });
  it('rolls back Seerr then removes only its owned webhook', async () => {
    ctx = context();
    await connect(ctx);
    await ctx.app.inject({ url: '/api/setup/diagnostic' });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/snapshot', payload: {} });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/apply', payload: {} });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup/rollback',
      payload: {},
    });
    expect(response.json()).toEqual({
      status: 'rolled_back',
      seerr: 'restored',
      webhook: 'removed',
    });
    expect(ctx.state.instances[0]?.preventSearch).toBe(false);
    expect(ctx.state.deleted).toBe(1);
  });
  it('treats a manually deleted owned webhook as already removed', async () => {
    ctx = context();
    await connect(ctx);
    await ctx.app.inject({ url: '/api/setup/diagnostic' });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/snapshot', payload: {} });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/apply', payload: {} });
    ctx.state.notifications = [];
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup/rollback',
      payload: {},
    });
    expect(response.json()).toMatchObject({ webhook: 'already_removed' });
  });
  it('reports manual intervention and keeps the webhook on rollback conflict', async () => {
    const state = initialState();
    state.instances[0] = { ...state.instances[0], preventSearch: true };
    ctx = context({}, state);
    await connect(ctx);
    await ctx.app.inject({ url: '/api/setup/diagnostic' });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/snapshot', payload: {} });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/apply', payload: {} });
    ctx.state.instances[0] = { ...ctx.state.instances[0], preventSearch: false };
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup/rollback',
      payload: {},
    });
    expect(response.json()).toMatchObject({ status: 'manual_intervention_required' });
    expect(ctx.state.deleted).toBe(0);
    expect(ctx.state.notifications).toHaveLength(1);
  });
  it('blocks all writes by default until the read-only probe is validated', async () => {
    ctx = context({ SETUP_WRITES_ENABLED: false });
    await connect(ctx);
    await ctx.app.inject({ url: '/api/setup/diagnostic' });
    await ctx.app.inject({ method: 'POST', url: '/api/setup/snapshot', payload: {} });
    const response = await ctx.app.inject({ method: 'POST', url: '/api/setup/apply', payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'writes_disabled' });
    expect(ctx.state.created).toBe(0);
  });
  it('previews apply with redacted payloads and no side effects', async () => {
    const state = initialState();
    state.instances[0] = {
      ...state.instances[0],
      tags: [1],
      tagRequests: true,
      activeProfileId: 6,
      activeProfileName: 'HD',
      activeDirectory: '/movies',
      minimumAvailability: 'released',
      isDefault: true,
      syncEnabled: true,
    };
    state.notifications = [
      {
        id: 20,
        implementation: 'Webhook',
        configContract: 'WebhookSettings',
        onMovieAdded: true,
        onMovieFileDeleteForUpgrade: true,
        fields: [{ name: 'url', value: 'http://scorerr:3000/api/webhooks/radarr' }],
      },
    ];
    ctx = context({ SETUP_WRITES_ENABLED: false }, state);
    await connect(ctx);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/setup/apply-preview' });
    expect(response.statusCode).toBe(200);
    const preview = response.json<{
      payloads: { seerr: Record<string, unknown> };
      [key: string]: unknown;
    }>();
    expect(preview).toMatchObject({
      mode: 'preview_only',
      noRemoteWritesPerformed: true,
      changes: [
        {
          id: 'radarr-create-webhook',
          status: 'skipped',
          reason: 'preexisting_compatible_extra_triggers',
        },
        { id: 'seerr-disable-auto-search', status: 'planned' },
      ],
    });
    expect(preview.payloads.seerr).not.toHaveProperty('tags');
    expect(preview.payloads.seerr).not.toHaveProperty('tagRequests');
    expect(response.body).not.toContain('nested-radarr-secret');
    expect(ctx.state.created).toBe(0);
    expect(ctx.state.deleted).toBe(0);
  });
  it('refuses the non-persistent Radarr test while its dedicated flag is false', async () => {
    ctx = context({ SETUP_WRITES_ENABLED: false, SETUP_NON_PERSISTENT_TESTS_ENABLED: false });
    await connect(ctx);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup/radarr/test-webhook',
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'non_persistent_tests_disabled' });
  });
  it('returns and stores a redacted real-probe compatibility report using GET clients only', async () => {
    ctx = context({ SETUP_WRITES_ENABLED: false });
    await connect(ctx);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/setup/probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'read_only',
      writesEnabled: false,
      radarr: { version: '6.2.1.10461', webhookSchemaEndpoint: { available: true } },
      seerr: { version: '2.7.3', preventSearch: false, preventSearchTypes: ['boolean'] },
      association: { matched: true, certain: true },
      sensitiveData: { detected: true },
    });
    expect(response.body).not.toContain('nested-radarr-secret');
    expect(ctx.state.created).toBe(0);
    expect(ctx.state.deleted).toBe(0);
    const stored = ctx.database.sqlite
      .prepare('SELECT report_json AS report FROM installation_probe_reports')
      .get() as { report: string };
    expect(stored.report).not.toContain('nested-radarr-secret');
  });
  it('reports a missing Radarr notification schema endpoint without failing the probe', async () => {
    const state = initialState();
    state.schemaMissing = true;
    ctx = context({ SETUP_WRITES_ENABLED: false }, state);
    await connect(ctx);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/setup/probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      radarr: { webhookSchemaEndpoint: { available: false, status: 'not_found' } },
    });
  });
});

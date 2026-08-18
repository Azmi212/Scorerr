import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/api/app.js';
import type { AppConfig } from '../src/config/env.js';
import { createDatabase, type DatabaseContext } from '../src/database/client.js';
import { applyMigrations } from '../src/database/migrate.js';
import { serviceConnections } from '../src/database/schema.js';
import { ServiceClientError } from '../src/security/redaction.js';
import { SqliteSecretStore } from '../src/security/secret-store.js';
import {
  ReleaseProbeService,
  type ReleaseProbeClientFactory,
} from '../src/services/release-probe-service.js';

interface ReleaseState {
  movie: unknown;
  releases: unknown;
  movieError?: ServiceClientError;
  releaseError?: ServiceClientError;
  waitForRelease?: Promise<void>;
  releaseStarted?: () => void;
  calls: string[];
}

interface ReleaseContext {
  app: ReturnType<typeof buildApp>;
  database: DatabaseContext;
  directory: string;
  state: ReleaseState;
  cleanup(): Promise<void>;
}

function createReleaseContext(
  configOverrides: Partial<AppConfig> = {},
  stateOverrides: Partial<ReleaseState> = {},
): ReleaseContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-release-probe-'));
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
    HTTP_MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
    SETUP_DIAGNOSTIC_TTL_MS: 300_000,
    SETUP_WRITES_ENABLED: false,
    SETUP_NON_PERSISTENT_TESTS_ENABLED: false,
    SETUP_SEERR_PROBE_WRITE_ENABLED: false,
    RELEASE_PROBE_ENABLED: true,
    RELEASE_PROBE_TIMEOUT_MS: 1_000,
    RELEASE_PROBE_COOLDOWN_MS: 0,
    WORKER_POLL_INTERVAL_MS: 100,
    WORKER_SCHEMA_WAIT_INTERVAL_MS: 100,
    WORKER_LOCK_TIMEOUT_MS: 300_000,
    WORKER_MAX_ATTEMPTS: 3,
    ...configOverrides,
  };
  const state: ReleaseState = {
    movie: { id: 42, title: 'Probe Movie' },
    releases: [],
    calls: [],
    ...stateOverrides,
  };
  const secrets = new SqliteSecretStore(database, dbPath);
  const secretRef = secrets.put('radarr-release-secret');
  const now = new Date();
  database.db
    .insert(serviceConnections)
    .values({
      service: 'radarr',
      alias: 'default',
      baseUrl: 'http://radarr:7878',
      secretRef,
      isActive: true,
      connectionStatus: 'connected',
      version: '6.2.1.10461',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const factory: ReleaseProbeClientFactory = () => ({
    movie: (movieId) => {
      state.calls.push(`GET /api/v3/movie/${String(movieId)}`);
      if (state.movieError) return Promise.reject(state.movieError);
      return Promise.resolve(state.movie);
    },
    releases: async (movieId) => {
      state.calls.push(`GET /api/v3/release?movieId=${String(movieId)}`);
      state.releaseStarted?.();
      if (state.waitForRelease) await state.waitForRelease;
      if (state.releaseError) throw state.releaseError;
      return state.releases;
    },
  });
  const releaseProbeService = new ReleaseProbeService(database, config, secrets, factory);
  const app = buildApp({ config, database, releaseProbeService });
  return {
    app,
    database,
    directory,
    state,
    cleanup: async () => {
      await app.close();
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('Release Probe API', () => {
  let context: ReleaseContext | undefined;
  afterEach(async () => context?.cleanup());

  it('refuses the probe while RELEASE_PROBE_ENABLED is false', async () => {
    context = createReleaseContext({ RELEASE_PROBE_ENABLED: false });
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'release_probe_disabled' });
    expect(context.state.calls).toEqual([]);
  });

  it('stores a missing movie as an exploitable failed report', async () => {
    context = createReleaseContext(
      {},
      {
        movieError: new ServiceClientError('not_found', 'Radarr movie was not found', 404),
      },
    );
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'failed',
      error: { code: 'not_found' },
      releaseCount: 0,
    });
    expect(context.state.calls).toEqual(['GET /api/v3/movie/42']);
  });

  it('stores an empty interactive search', async () => {
    context = createReleaseContext();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(response.json()).toMatchObject({
      status: 'completed',
      film: { id: 42, title: 'Probe Movie' },
      radarrVersion: '6.2.1.10461',
      releaseCount: 0,
      protocolsObserved: [],
    });
    expect(context.state.calls).toEqual(['GET /api/v3/movie/42', 'GET /api/v3/release?movieId=42']);
  });

  it('inventories torrent, Usenet, missing seeders, and rejected releases without parsing messages', async () => {
    context = createReleaseContext(
      {},
      {
        releases: [
          {
            title: 'Torrent A',
            protocol: 'torrent',
            indexer: 'Tracker',
            size: 1000,
            seeders: 12,
            leechers: 3,
            customFormatScore: 10,
            rejected: false,
            quality: { quality: { name: 'Bluray-1080p' } },
          },
          {
            title: 'Torrent B',
            protocol: 'torrent',
            indexer: 'Tracker',
            size: 2000,
            rejected: true,
            rejections: ['Human diagnostic only'],
          },
          {
            title: 'Usenet A',
            protocol: 'usenet',
            indexer: 'Newznab',
            size: 3000,
            age: 2,
            grabs: 8,
            rejected: false,
          },
        ],
      },
    );
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    const report = response.json<{
      releaseCount: number;
      protocolsObserved: string[];
      protocolStatistics: Record<
        string,
        { seeders: { observed: number }; grabs: { observed: number } }
      >;
      fieldInventory: {
        fieldsAlwaysPresent: string[];
        fieldsSometimesPresent: string[];
        observedTypes: Record<string, string[]>;
      };
      releases: Record<string, unknown>[];
    }>();
    expect(report.releaseCount).toBe(3);
    expect(report.protocolsObserved).toEqual(['torrent', 'usenet']);
    expect(report.protocolStatistics.torrent?.seeders.observed).toBe(1);
    expect(report.protocolStatistics.usenet?.seeders.observed).toBe(0);
    expect(report.protocolStatistics.usenet?.grabs.observed).toBe(1);
    expect(report.fieldInventory.fieldsAlwaysPresent).toEqual(
      expect.arrayContaining(['title', 'protocol', 'indexer', 'size', 'rejected']),
    );
    expect(report.fieldInventory.fieldsSometimesPresent).toEqual(
      expect.arrayContaining(['seeders', 'rejections', 'grabs']),
    );
    expect(report.fieldInventory.observedTypes.seeders).toEqual(['number']);
    expect(report.releases[1]).toMatchObject({
      rejected: true,
      rejections: ['Human diagnostic only'],
    });
  });

  it('redacts sensitive release URLs before response and storage', async () => {
    context = createReleaseContext(
      {},
      {
        releases: [
          {
            title: 'Sensitive',
            protocol: 'torrent',
            downloadUrl: 'https://tracker.example/download/123?passkey=SECRET',
            apiKey: 'LEAK',
            rejected: false,
          },
        ],
      },
    );
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(response.body).not.toContain('SECRET');
    expect(response.body).not.toContain('LEAK');
    expect(response.body).toContain('passkey=[REDACTED]');
    const stored = JSON.stringify(
      context.database.sqlite.prepare('SELECT * FROM release_probe_items').all(),
    );
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toContain('LEAK');
  });

  it('stores timeout and Radarr/indexer errors without killing the API', async () => {
    context = createReleaseContext(
      {},
      {
        releaseError: new ServiceClientError('timeout', 'Service request timed out'),
      },
    );
    const timeout = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(timeout.json()).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
    expect((await context.app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('stores a non-timeout indexer/Radarr error as a failed probe', async () => {
    context = createReleaseContext(
      {},
      {
        releaseError: new ServiceClientError(
          'incompatible_response',
          'Radarr interactive search failed',
        ),
      },
    );
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(response.json()).toMatchObject({
      status: 'failed',
      error: { code: 'incompatible_response', message: 'Radarr interactive search failed' },
    });
  });

  it('rejects two concurrent probes for the same movie', async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let releaseSearch!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    context = createReleaseContext({}, { waitForRelease, releaseStarted });
    const firstPromise = context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    await started;
    const second = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'release_probe_conflict' });
    releaseSearch();
    expect((await firstPromise).statusCode).toBe(200);
  });

  it('enforces cooldown after a completed probe', async () => {
    context = createReleaseContext({ RELEASE_PROBE_COOLDOWN_MS: 60_000 });
    await context.app.inject({ method: 'POST', url: '/api/probe/releases/42', payload: {} });
    const second = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: 'release_probe_cooldown' });
  });

  it('retrieves a persisted report and never issues a mutating Radarr method', async () => {
    context = createReleaseContext({}, { releases: [{ title: 'Read only', protocol: 'usenet' }] });
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/probe/releases/42',
      payload: {},
    });
    const probeId = created.json<{ id: number }>().id;
    const fetched = await context.app.inject({
      method: 'GET',
      url: `/api/probe/releases/${String(probeId)}`,
    });
    expect(fetched.json()).toMatchObject({ id: probeId, releaseCount: 1 });
    expect(context.state.calls.every((call) => call.startsWith('GET '))).toBe(true);
    expect(context.state.calls.join(' ')).not.toMatch(/grab|download|command|POST|PUT|DELETE/i);
  });

  it('serves the minimal manual Release Probe page', async () => {
    context = createReleaseContext();
    const response = await context.app.inject({ method: 'GET', url: '/probe/releases' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Analyser les releases');
  });
});

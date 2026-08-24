import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/api/app.js';
import type { AppConfig } from '../src/config/env.js';
import { createDatabase, type DatabaseContext } from '../src/database/client.js';
import { applyMigrations } from '../src/database/migrate.js';
import {
  profileRules,
  serviceConnections,
  simulationReleases,
  simulations,
} from '../src/database/schema.js';
import { SqliteSecretStore } from '../src/security/secret-store.js';
import { ProfileService, type CreateProfileInput } from '../src/services/profile-service.js';
import {
  SimulationService,
  type SimulationClient,
  type SimulationClientFactory,
} from '../src/services/simulation-service.js';
import {
  claimNextSimulation,
  recoverAbandonedSimulations,
} from '../src/services/simulation-task-service.js';

const gibibyte = 1024 * 1024 * 1024;

function profileInput(name: string, isDefault = false): CreateProfileInput {
  return {
    name,
    description: `${name} description`,
    isDefault,
    rules: [
      {
        type: 'language',
        position: 0,
        configVersion: 2,
        config: { importance: 'low', preferredLanguages: ['fr', 'en'], fallback: 'original' },
      },
      {
        type: 'seeders',
        position: 1,
        configVersion: 1,
        config: { importance: 'medium', desiredMinimum: 3, requireMinimum: false },
      },
      {
        type: 'resolution',
        position: 2,
        configVersion: 1,
        config: {
          importance: 'high',
          preferredHeight: 1080,
          desiredMinimumHeight: 720,
          requireMinimum: true,
        },
      },
      {
        type: 'source',
        position: 3,
        configVersion: 1,
        config: { importance: 'priority', preferredSources: ['bluray', 'webdl'] },
      },
      {
        type: 'size',
        position: 4,
        configVersion: 1,
        config: { importance: 'low', desiredMaximumBytes: 10 * gibibyte, requireMaximum: false },
      },
      {
        type: 'codec',
        position: 5,
        configVersion: 1,
        config: { importance: 'low', preferredCodecs: ['hevc', 'avc'] },
      },
      {
        type: 'custom_formats',
        position: 6,
        configVersion: 1,
        config: { importance: 'low', useRadarrPreferences: true },
      },
      {
        type: 'indexer',
        position: 7,
        configVersion: 1,
        config: { importance: 'low', preferredIndexers: [], allowOthers: true },
      },
    ],
  };
}

function release(
  title: string,
  options: {
    approved?: boolean;
    rejected?: boolean;
    resolution?: number;
    source?: string;
    seeders?: number;
    rejections?: unknown[];
    apiKey?: string;
  } = {},
): Record<string, unknown> {
  return {
    title,
    guid: `guid-${title}`,
    protocol: 'torrent',
    approved: options.approved ?? true,
    rejected: options.rejected ?? false,
    rejections: options.rejections ?? [],
    seeders: options.seeders ?? 10,
    size: 2 * gibibyte,
    quality: {
      quality: {
        name: `${String(options.resolution ?? 1080)}p`,
        resolution: options.resolution ?? 1080,
        source: options.source ?? 'bluray',
      },
    },
    languages: [{ id: 2, name: 'English' }],
    customFormats: [],
    customFormatScore: 0,
    indexer: 'Test Indexer',
    indexerId: 1,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  };
}

interface SimulationTestContext {
  app: ReturnType<typeof buildApp>;
  database: DatabaseContext;
  profiles: ProfileService;
  simulationService: SimulationService;
  calls: string[];
  setMovies: (movies: unknown) => void;
  setMovie: (movie: unknown) => void;
  setReleases: (releases: unknown) => void;
  addRadarr: (alias: string, isDefault: boolean) => number;
  cleanup: () => Promise<void>;
}

function createContext(): SimulationTestContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-simulation-'));
  const databasePath = path.join(directory, 'test.db');
  const database = createDatabase(databasePath);
  applyMigrations(database);
  const config: AppConfig = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    DATABASE_PATH: databasePath,
    LOG_LEVEL: 'silent',
    BODY_LIMIT_BYTES: 1024 * 1024,
    SCORERR_PUBLIC_URL: 'http://scorerr:3000',
    HTTP_TIMEOUT_MS: 5000,
    HTTP_MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
    SETUP_DIAGNOSTIC_TTL_MS: 300_000,
    SETUP_WRITES_ENABLED: false,
    SETUP_NON_PERSISTENT_TESTS_ENABLED: false,
    SETUP_SEERR_PROBE_WRITE_ENABLED: false,
    RELEASE_PROBE_ENABLED: false,
    RELEASE_PROBE_TIMEOUT_MS: 120_000,
    RELEASE_PROBE_COOLDOWN_MS: 0,
    WORKER_POLL_INTERVAL_MS: 100,
    WORKER_SCHEMA_WAIT_INTERVAL_MS: 100,
    WORKER_LOCK_TIMEOUT_MS: 300_000,
    WORKER_MAX_ATTEMPTS: 3,
  };
  const secrets = new SqliteSecretStore(database, databasePath);
  const profiles = new ProfileService(database);
  const calls: string[] = [];
  let moviesResult: unknown = [{ id: 42, title: 'Film', originalLanguage: 'en' }];
  let movieResult: unknown = { id: 42, title: 'Film', originalLanguage: 'en' };
  let releasesResult: unknown = [];
  const factory: SimulationClientFactory = (baseUrl, apiKey) => {
    expect(apiKey).toMatch(/^key-/);
    const client: SimulationClient = {
      movies: () => {
        calls.push(`GET ${baseUrl}/api/v3/movie`);
        return Promise.resolve(moviesResult);
      },
      movie: (movieId) => {
        calls.push(`GET ${baseUrl}/api/v3/movie/${String(movieId)}`);
        return Promise.resolve(movieResult);
      },
      releases: (movieId) => {
        calls.push(`GET ${baseUrl}/api/v3/release?movieId=${String(movieId)}`);
        return Promise.resolve(releasesResult);
      },
    };
    return client;
  };
  const simulationService = new SimulationService(database, config, secrets, factory, profiles);
  const app = buildApp({ config, database, simulationService, profileService: profiles });

  return {
    app,
    database,
    profiles,
    calls,
    setMovies: (value) => {
      moviesResult = value;
    },
    setMovie: (value) => {
      movieResult = value;
    },
    setReleases: (value) => {
      releasesResult = value;
    },
    addRadarr: (alias, isDefault) => {
      const now = new Date();
      const secretRef = secrets.put(`key-${alias}`);
      const inserted = database.db
        .insert(serviceConnections)
        .values({
          service: 'radarr',
          alias,
          baseUrl: `http://${alias}:7878`,
          secretRef,
          isActive: true,
          isDefault,
          connectionStatus: 'connected',
          version: '6.2.1',
          instanceName: alias,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return Number(inserted.lastInsertRowid);
    },
    simulationService,
    cleanup: async () => {
      await app.close();
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function executeQueued(context: SimulationTestContext, simulationId: number): Promise<void> {
  const claimed = claimNextSimulation(context.database, 'test-worker');
  expect(claimed?.id).toBe(simulationId);
  await context.simulationService.executeClaimed(simulationId, 'test-worker');
}

describe('Phase 5 simulation API', () => {
  let context: SimulationTestContext | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await context?.cleanup();
    context = undefined;
  });

  it('lists only movies from the default or explicitly selected Radarr using GET', async () => {
    context = createContext();
    const defaultRadarr = context.addRadarr('radarr-default', true);
    const otherRadarr = context.addRadarr('radarr-other', false);
    context.setMovies([
      { id: 42, title: 'Film A', apiKey: 'must-not-leak' },
      { id: 43, title: 'Film B' },
    ]);

    const defaultResponse = await context.app.inject({ url: '/api/simulations/movies' });
    const explicitResponse = await context.app.inject({
      url: `/api/simulations/movies?radarrConnectionId=${String(otherRadarr)}`,
    });

    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json()).toMatchObject({
      radarr: { id: defaultRadarr, alias: 'radarr-default' },
      movies: [
        { id: 42, title: 'Film A', apiKey: '[REDACTED]' },
        { id: 43, title: 'Film B' },
      ],
    });
    expect(explicitResponse.json()).toMatchObject({ radarr: { id: otherRadarr } });
    expect(context.calls).toEqual([
      'GET http://radarr-default:7878/api/v3/movie',
      'GET http://radarr-other:7878/api/v3/movie',
    ]);
  });

  it('never treats active Radarr instances as an implicit default', async () => {
    context = createContext();
    const radarrA = context.addRadarr('radarr-a', false);
    context.addRadarr('radarr-b', false);
    context.database.db
      .update(serviceConnections)
      .set({ isActive: false })
      .where(eq(serviceConnections.id, radarrA))
      .run();
    context.profiles.create(profileInput('Default profile', true));

    const withoutDefault = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    expect(withoutDefault.statusCode).toBe(404);
    expect(withoutDefault.json()).toMatchObject({ code: 'default_radarr_not_configured' });

    const explicit = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42, radarrConnectionId: radarrA },
    });
    expect(explicit.statusCode).toBe(202);
    const explicitBody = explicit.json<{ id: number; status: string }>();
    expect(explicitBody.status).toBe('queued');
    expect(typeof explicitBody.id).toBe('number');
  });

  it('persists immutable snapshots, all categories, reasons, progress and informational order', async () => {
    context = createContext();
    const radarrId = context.addRadarr('radarr-default', true);
    const profile = context.profiles.create(profileInput('Default profile', true));
    context.setMovie({
      id: 42,
      title: 'Film',
      originalLanguage: 'en',
      apiKey: 'movie-secret',
    });
    context.setReleases([
      release('Radarr rejected', {
        approved: false,
        rejected: true,
        rejections: [{ reason: 'Wrong quality', type: 'quality' }],
      }),
      release('Profile refused', { resolution: 480 }),
      release('Eliminated by source', { source: 'webdl', seeders: 500 }),
      release('Functional finalist A', { source: 'bluray', seeders: 10, apiKey: 'release-secret' }),
      release('Functional finalist B', { source: 'bluray', seeders: 10 }),
    ]);

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });

    expect(created.statusCode).toBe(202);
    expect(created.json<{ status: string }>().status).toBe('queued');
    expect(context.calls).toEqual([]);
    const simulationId = created.json<{ id: number }>().id;
    context.profiles.update(profile.id, { name: 'Changed before execution' });
    await executeQueued(context, simulationId);
    const completed = await context.app.inject({ url: `/api/simulations/${String(simulationId)}` });
    const body = completed.json<Record<string, unknown>>() as {
      id: number;
      status: string;
      profile: { id: number; revision: number; name: string };
      radarr: { id: number };
      progress: { code: string; label: string; status: string }[];
      summary: Record<string, number>;
      selection: { ok: boolean; selection: { winner: { fingerprint: string } } };
      releases: { category: string; reasons: unknown[]; eliminatedAtStep: number | null }[];
      informationalOrdering: boolean;
    };
    expect(body.status).toBe('completed');
    expect(claimNextSimulation(context.database, 'late-worker')).toBeUndefined();
    expect(body.radarr.id).toBe(radarrId);
    expect(body.profile).toMatchObject({ id: profile.id, revision: profile.revision });
    expect(body.progress).toMatchObject([
      { code: 'film_found', label: 'Film trouvé', status: 'completed' },
      { code: 'releases_retrieved', label: 'Releases récupérées', status: 'completed' },
      {
        code: 'preferences_analyzed',
        label: 'Analyse des préférences',
        status: 'completed',
      },
      { code: 'selection_calculated', label: 'Calcul du classement', status: 'completed' },
    ]);
    expect(body.summary).toEqual({
      total: 5,
      radarrRejected: 1,
      scorerrRefused: 1,
      selectionEliminated: 1,
      finalists: 1,
      selected: 1,
    });
    expect(body.releases.map((item) => item.category)).toEqual([
      'selected',
      'finalist',
      'selection_eliminated',
      'scorerr_refused',
      'radarr_rejected',
    ]);
    const selectedRelease = body.releases.find((item) => item.category === 'selected') as
      { evaluation?: { release?: { fingerprint?: string } } } | undefined;
    expect(selectedRelease?.evaluation?.release?.fingerprint).toBe(
      body.selection.selection.winner.fingerprint,
    );
    expect(body.releases.find((item) => item.category === 'radarr_rejected')?.reasons).toEqual([
      {
        code: 'radarr_rejected',
        reasons: ['radarr_not_approved', 'radarr_rejected'],
        rejections: [{ reason: 'Wrong quality', type: 'quality' }],
      },
    ]);
    expect(
      body.releases.find((item) => item.category === 'scorerr_refused')?.reasons,
    ).toMatchObject([{ code: 'profile_constraint_failed', rule: 'resolution' }]);
    const eliminatedRelease = body.releases.find(
      (item) => item.category === 'selection_eliminated',
    );
    expect(eliminatedRelease).toMatchObject({
      reasons: [{ code: 'eliminated_by_rule', rule: 'source', tier: 'priority' }],
    });
    expect(typeof eliminatedRelease?.eliminatedAtStep).toBe('number');
    expect(body.informationalOrdering).toBe(true);
    expect(context.calls).toEqual([
      'GET http://radarr-default:7878/api/v3/movie/42',
      'GET http://radarr-default:7878/api/v3/release?movieId=42',
    ]);

    context.profiles.update(profile.id, { name: 'Changed later' });
    const fetched = await context.app.inject({ url: `/api/simulations/${String(body.id)}` });
    expect(fetched.json()).toMatchObject({
      profile: { id: profile.id, revision: profile.revision, name: 'Default profile' },
    });
    const history = await context.app.inject({ url: '/api/simulations' });
    expect(history.json()).toMatchObject({
      simulations: [{ id: body.id, status: 'completed', profile: { revision: profile.revision } }],
    });
    const persisted = JSON.stringify({
      simulations: context.database.db.select().from(simulations).all(),
      releases: context.database.db.select().from(simulationReleases).all(),
    });
    expect(persisted).not.toContain('movie-secret');
    expect(persisted).not.toContain('release-secret');
    expect(persisted).not.toContain('key-radarr-default');
  });

  it('returns no_suitable_release without rehabilitating rejected releases', async () => {
    context = createContext();
    context.addRadarr('radarr-default', true);
    context.profiles.create(profileInput('Default profile', true));
    context.setReleases([
      release('Rejected one', { approved: false, rejected: true }),
      release('Rejected two', { approved: false, rejected: true }),
      release('Hard constraint', { resolution: 480 }),
    ]);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    expect(response.statusCode).toBe(202);
    const simulationId = response.json<{ id: number }>().id;
    await executeQueued(context, simulationId);
    const completed = await context.app.inject({ url: `/api/simulations/${String(simulationId)}` });
    const body = completed.json<{
      status: string;
      outcome: string;
      result: { code: string; selectedRelease: unknown; summary: Record<string, number> };
      selection: unknown;
      releases: { category: string }[];
    }>();

    expect(body.status).toBe('completed');
    expect(body.outcome).toBe('no_suitable_release');
    expect(body.result).toMatchObject({
      code: 'no_suitable_release',
      selectedRelease: null,
      summary: { radarrRejected: 2, scorerrRefused: 1, selected: 0 },
    });
    expect(body.selection).toBeNull();
    expect(body.releases.map((item) => item.category)).toEqual([
      'scorerr_refused',
      'radarr_rejected',
      'radarr_rejected',
    ]);
  });

  it('uses explicit profile and Radarr ids and rejects Language V1 before remote access', async () => {
    context = createContext();
    context.addRadarr('radarr-default', true);
    const otherRadarr = context.addRadarr('radarr-other', false);
    context.profiles.create(profileInput('Default profile', true));
    const explicitProfile = context.profiles.create(profileInput('Editor profile'));
    context.setReleases([release('Only release')]);

    const explicit = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: {
        movieId: 42,
        profileId: explicitProfile.id,
        radarrConnectionId: otherRadarr,
      },
    });
    expect(explicit.json<{ status: string }>().status).toBe('queued');
    expect(context.simulationService.get(explicit.json<{ id: number }>().id)).toMatchObject({
      profile: { id: explicitProfile.id, revision: explicitProfile.revision },
      radarr: { id: otherRadarr },
    });

    context.database.db
      .update(profileRules)
      .set({
        configVersion: 1,
        configJson: JSON.stringify({ preferredLanguages: ['fr'], fallback: 'original' }),
      })
      // The test deliberately restores a persisted legacy Language V1 rule.
      .where(and(eq(profileRules.profileId, explicitProfile.id), eq(profileRules.type, 'language')))
      .run();
    const callsBeforeLegacy = context.calls.length;
    const legacy = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42, profileId: explicitProfile.id, radarrConnectionId: otherRadarr },
    });
    expect(legacy.statusCode).toBe(422);
    expect(legacy.json()).toMatchObject({ code: 'profile_upgrade_required' });
    expect(context.calls).toHaveLength(callsBeforeLegacy);
  });

  it('requires explicit defaults and persists a failed remote run with partial progress', async () => {
    context = createContext();
    const missingRadarr = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    expect(missingRadarr.statusCode).toBe(404);
    expect(missingRadarr.json()).toMatchObject({ code: 'default_radarr_not_configured' });

    context.addRadarr('radarr-default', true);
    const missingProfile = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    expect(missingProfile.statusCode).toBe(404);
    expect(missingProfile.json()).toMatchObject({ code: 'default_profile_not_configured' });

    context.profiles.create(profileInput('Default profile', true));
    context.setMovie({ id: 999, title: 'Wrong film' });
    const failed = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    expect(failed.statusCode).toBe(202);
    const failedId = failed.json<{ id: number }>().id;
    await executeQueued(context, failedId);
    const failedResult = await context.app.inject({ url: `/api/simulations/${String(failedId)}` });
    const failedBody = failedResult.json<{ progress: { status: string }[] }>();
    expect(failedBody).toMatchObject({
      status: 'failed',
      error: { code: 'not_found' },
    });
    expect(failedBody.progress.map((step) => step.status)).toEqual([
      'failed',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('exposes real worker progression and keeps the API request non-blocking', async () => {
    context = createContext();
    context.addRadarr('radarr-default', true);
    context.profiles.create(profileInput('Default profile', true));
    let resolveMovie: ((movie: unknown) => void) | undefined;
    const pendingMovie = new Promise<unknown>((resolve) => {
      resolveMovie = resolve;
    });
    context.setMovie(pendingMovie);

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    const id = created.json<{ id: number }>().id;
    const claimed = claimNextSimulation(context.database, 'progress-worker');
    expect(claimed?.id).toBe(id);
    const execution = context.simulationService.executeClaimed(id, 'progress-worker');

    await vi.waitFor(async () => {
      const observed = await context?.app.inject({ url: `/api/simulations/${String(id)}` });
      const body = observed?.json<{
        status: string;
        progress: { code: string; status: string }[];
      }>();
      expect(body?.status).toBe('running');
      expect(body?.progress[0]).toMatchObject({ code: 'film_found', status: 'in_progress' });
    });
    resolveMovie?.({ id: 42, title: 'Film', originalLanguage: 'en' });
    await execution;
    const completed = await context.app.inject({ url: `/api/simulations/${String(id)}` });
    expect(completed.json()).toMatchObject({ status: 'completed', outcome: 'no_suitable_release' });
  });

  it('claims atomically, recovers expired locks and does not duplicate persisted releases', async () => {
    context = createContext();
    context.addRadarr('radarr-default', true);
    context.profiles.create(profileInput('Default profile', true));
    context.setReleases([release('Only release')]);
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    const id = created.json<{ id: number }>().id;
    const claimTime = Date.now() + 10;
    const first = claimNextSimulation(context.database, 'worker-a', claimTime);
    expect(first?.id).toBe(id);
    expect(claimNextSimulation(context.database, 'worker-b', claimTime)).toBeUndefined();
    expect(recoverAbandonedSimulations(context.database, 100, 3, claimTime + 101)).toEqual({
      requeued: 1,
      failed: 0,
    });
    const recovered = claimNextSimulation(context.database, 'worker-b', claimTime + 101);
    expect(recovered).toMatchObject({ id, attempts: 2 });
    await context.simulationService.executeClaimed(id, 'worker-b');
    expect(
      context.database.db
        .select()
        .from(simulationReleases)
        .where(eq(simulationReleases.simulationId, id))
        .all(),
    ).toHaveLength(1);
    context.database.db
      .update(simulations)
      .set({
        status: 'queued',
        availableAt: new Date(claimTime + 1_000),
        lockedAt: null,
        lockedBy: null,
      })
      .where(eq(simulations.id, id))
      .run();
    expect(claimNextSimulation(context.database, 'worker-c', claimTime + 1_000)?.id).toBe(id);
    await context.simulationService.executeClaimed(id, 'worker-c');
    expect(
      context.database.db
        .select()
        .from(simulationReleases)
        .where(eq(simulationReleases.simulationId, id))
        .all(),
    ).toHaveLength(1);
  });

  it('fails the frozen simulation instead of falling back when its Radarr disappears', async () => {
    context = createContext();
    const selectedRadarr = context.addRadarr('radarr-default', true);
    context.addRadarr('radarr-other', false);
    context.profiles.create(profileInput('Default profile', true));
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    const id = created.json<{ id: number }>().id;
    context.database.db
      .delete(serviceConnections)
      .where(eq(serviceConnections.id, selectedRadarr))
      .run();
    await executeQueued(context, id);
    const failed = await context.app.inject({ url: `/api/simulations/${String(id)}` });
    expect(failed.json()).toMatchObject({
      status: 'failed',
      error: { code: 'radarr_connection_unavailable' },
      radarr: { id: selectedRadarr },
    });
    expect(context.calls).toEqual([]);
    expect(claimNextSimulation(context.database, 'late-worker')).toBeUndefined();
  });

  it('marks the current step failed after definitive lock recovery', async () => {
    context = createContext();
    context.addRadarr('radarr-default', true);
    context.profiles.create(profileInput('Default profile', true));
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { movieId: 42 },
    });
    const id = created.json<{ id: number }>().id;
    const claimTime = Date.now() + 10;
    expect(claimNextSimulation(context.database, 'crashed-worker', claimTime)?.id).toBe(id);
    expect(recoverAbandonedSimulations(context.database, 100, 1, claimTime + 101)).toEqual({
      requeued: 0,
      failed: 1,
    });

    const failed = await context.app.inject({ url: `/api/simulations/${String(id)}` });
    const body = failed.json<{
      status: string;
      progress: { status: string; error: { code: string } | null }[];
    }>();
    expect(body.status).toBe('failed');
    expect(body.progress[0]).toMatchObject({
      status: 'failed',
      error: { code: 'maximum_attempts_reached_after_lock_expiry' },
    });
    expect(claimNextSimulation(context.database, 'late-worker', claimTime + 200)).toBeUndefined();
  });

  it('keeps Phase 5 independent from diagnostic ordering and every mutating Radarr method', () => {
    const serviceSource = fs.readFileSync(
      path.resolve('src/services/simulation-service.ts'),
      'utf8',
    );
    const clientSource = fs.readFileSync(
      path.resolve('src/clients/radarr-release-probe-client.ts'),
      'utf8',
    );

    expect(serviceSource).not.toContain('releaseComparison');
    expect(serviceSource).not.toContain('torrentAvailabilitySignal');
    expect(serviceSource).not.toContain('compareEligibleReleases');
    expect(serviceSource).not.toMatch(/\.sort\s*\(/u);
    expect(clientSource).not.toMatch(/request\(['"](?:POST|PUT|PATCH|DELETE)['"]/u);
    expect(clientSource.toLowerCase()).not.toContain('grab(');
    expect(clientSource.toLowerCase()).not.toContain('download(');
  });
});

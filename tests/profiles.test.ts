import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { profileRules, serviceConnections } from '../src/database/schema.js';
import { createTestContext, type TestContext } from './helpers.js';

interface ProfileResponse {
  id: number;
  name: string;
  description: string | null;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  rules: {
    type: string;
    position: number;
    configVersion: number;
    config: Record<string, unknown>;
  }[];
}

function profilePayload(): Record<string, unknown> {
  return {
    name: 'Cinéma principal',
    description: 'Stratégie de sélection locale.',
    rules: [
      {
        type: 'language',
        position: 0,
        configVersion: 1,
        config: { preferredLanguages: ['fr', 'en'], fallback: 'original' },
      },
      {
        type: 'seeders',
        position: 1,
        configVersion: 1,
        config: { importance: 'high', desiredMinimum: 3, requireMinimum: false },
      },
      {
        type: 'resolution',
        position: 2,
        configVersion: 1,
        config: {
          importance: 'medium',
          preferredHeight: 2160,
          desiredMinimumHeight: 720,
          requireMinimum: false,
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
        config: {
          importance: 'medium',
          desiredMaximumBytes: 10 * 1024 * 1024 * 1024,
          requireMaximum: false,
        },
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
        config: { importance: 'priority', useRadarrPreferences: true },
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

function rulesFrom(payload: Record<string, unknown>): Record<string, unknown>[] {
  const rules = payload.rules;
  if (!Array.isArray(rules)) throw new Error('Profile fixture invariant violated');
  return rules as Record<string, unknown>[];
}

async function createProfile(context: TestContext): Promise<ProfileResponse> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/profiles',
    payload: profilePayload(),
  });
  expect(response.statusCode).toBe(201);
  return response.json<ProfileResponse>();
}

function insertServiceConnection(context: TestContext, service: 'radarr' | 'seerr'): number {
  const now = new Date();
  const result = context.database.db
    .insert(serviceConnections)
    .values({
      service,
      alias: `${service}-fixture`,
      baseUrl: `http://${service}-fixture:7878`,
      secretRef: `${service}-fixture-secret`,
      isActive: false,
      connectionStatus: 'untested',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return Number(result.lastInsertRowid);
}

describe('Profiles API', () => {
  let context: TestContext | undefined;
  afterEach(async () => context?.cleanup());

  it('creates, reads, and lists a profile with exactly the eight ordered rules without a network call', async () => {
    context = createTestContext();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network is forbidden'));
    try {
      const created = await createProfile(context);
      expect(created).toMatchObject({
        name: 'Cinéma principal',
        description: 'Stratégie de sélection locale.',
        schemaVersion: 1,
        revision: 1,
      });
      expect(created.createdAt).toEqual(expect.any(String));
      expect(created.updatedAt).toEqual(expect.any(String));
      expect(created.rules.map((rule) => rule.type)).toEqual([
        'language',
        'seeders',
        'resolution',
        'source',
        'size',
        'codec',
        'custom_formats',
        'indexer',
      ]);
      expect(created.rules[0]?.config).toMatchObject({ preferredLanguages: ['fr', 'en'] });
      const fetched = await context.app.inject({
        method: 'GET',
        url: `/api/profiles/${String(created.id)}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json<ProfileResponse>()).toEqual(created);
      const listed = await context.app.inject({ method: 'GET', url: '/api/profiles' });
      expect(listed.json<{ profiles: ProfileResponse[] }>().profiles).toEqual([created]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('increments revision when profile metadata is persisted', async () => {
    context = createTestContext();
    const created = await createProfile(context);
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/profiles/${String(created.id)}`,
      payload: { name: 'Cinéma révisé' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ProfileResponse>()).toMatchObject({
      name: 'Cinéma révisé',
      revision: 2,
    });
  });

  it('persists a full reordered rule set atomically and increments revision once', async () => {
    context = createTestContext();
    const created = await createProfile(context);
    const reordered = structuredClone(profilePayload());
    const rules = rulesFrom(reordered)
      .reverse()
      .map((rule, position) => ({ ...rule, position }));
    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/profiles/${String(created.id)}/rules`,
      payload: { rules },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ProfileResponse>()).toMatchObject({ revision: 2 });
    expect(response.json<ProfileResponse>().rules.map((rule) => rule.type)).toEqual([
      'indexer',
      'custom_formats',
      'codec',
      'size',
      'source',
      'resolution',
      'seeders',
      'language',
    ]);
  });

  it('rejects duplicate rule types and invalid configurations without partially changing a profile', async () => {
    context = createTestContext();
    const created = await createProfile(context);
    const duplicate = structuredClone(profilePayload());
    const duplicateRules = rulesFrom(duplicate);
    duplicateRules[7] = { ...duplicateRules[7], type: 'language' };
    const duplicateResponse = await context.app.inject({
      method: 'PUT',
      url: `/api/profiles/${String(created.id)}/rules`,
      payload: { rules: duplicateRules },
    });
    expect(duplicateResponse.statusCode).toBe(400);

    const invalid = structuredClone(profilePayload());
    const invalidRules = rulesFrom(invalid);
    const language = invalidRules[0];
    if (!language) throw new Error('Profile fixture invariant violated');
    language.config = {
      preferredLanguages: ['fr'],
      fallback: 'original',
      unexpected: true,
    };
    const invalidResponse = await context.app.inject({
      method: 'PUT',
      url: `/api/profiles/${String(created.id)}/rules`,
      payload: { rules: invalidRules },
    });
    expect(invalidResponse.statusCode).toBe(400);

    const unchanged = await context.app.inject({
      method: 'GET',
      url: `/api/profiles/${String(created.id)}`,
    });
    expect(unchanged.json<ProfileResponse>()).toEqual(created);
  });

  it('requires indexer references to point to an existing Radarr connection', async () => {
    context = createTestContext();
    const radarrConnectionId = insertServiceConnection(context, 'radarr');
    const payload = profilePayload();
    const indexer = rulesFrom(payload)[7];
    if (!indexer) throw new Error('Profile fixture invariant violated');
    indexer.config = {
      importance: 'low',
      preferredIndexers: [{ radarrConnectionId, indexerId: 17 }],
      allowOthers: true,
    };
    const created = await context.app.inject({ method: 'POST', url: '/api/profiles', payload });
    expect(created.statusCode).toBe(201);
    expect(created.json<ProfileResponse>().rules[7]?.config).toEqual(indexer.config);

    const seerrConnectionId = insertServiceConnection(context, 'seerr');
    const invalidPayload = profilePayload();
    const invalidIndexer = rulesFrom(invalidPayload)[7];
    if (!invalidIndexer) throw new Error('Profile fixture invariant violated');
    invalidIndexer.config = {
      importance: 'low',
      preferredIndexers: [{ radarrConnectionId: seerrConnectionId, indexerId: 17 }],
      allowOthers: true,
    };
    const invalid = await context.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: invalidPayload,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'invalid_indexer_connection' });
  });

  it('deletes a profile and cascades deletion to all of its rules', async () => {
    context = createTestContext();
    const created = await createProfile(context);
    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/profiles/${String(created.id)}`,
    });
    expect(response.statusCode).toBe(204);
    expect(
      context.database.db
        .select()
        .from(profileRules)
        .where(eq(profileRules.profileId, created.id))
        .all(),
    ).toEqual([]);
    const fetched = await context.app.inject({
      method: 'GET',
      url: `/api/profiles/${String(created.id)}`,
    });
    expect(fetched.statusCode).toBe(404);
  });
});

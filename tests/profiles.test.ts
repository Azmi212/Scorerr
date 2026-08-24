import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { profileRules, profiles, serviceConnections } from '../src/database/schema.js';
import { profileRuleTypes, type ProfileRuleType } from '../src/services/profile-service.js';
import { createTestContext, type TestContext } from './helpers.js';

interface ProfileResponse {
  id: number;
  name: string;
  description: string | null;
  schemaVersion: number;
  revision: number;
  isDefault: boolean;
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
        configVersion: 2,
        config: { importance: 'high', preferredLanguages: ['fr', 'en'], fallback: 'original' },
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

function isProfileRuleType(value: unknown): value is ProfileRuleType {
  return typeof value === 'string' && profileRuleTypes.includes(value as ProfileRuleType);
}

function legacyLanguageRules(): Record<string, unknown>[] {
  const rules = structuredClone(rulesFrom(profilePayload()));
  const language = rules.find((rule) => rule.type === 'language');
  if (!language) throw new Error('Legacy profile fixture is missing Language.');
  language.configVersion = 1;
  language.config = { preferredLanguages: ['fr', 'en'], fallback: 'original' };
  return rules;
}

function insertLegacyProfile(context: TestContext): number {
  const now = new Date('2026-01-02T03:04:05.000Z');
  const profileResult = context.database.db
    .insert(profiles)
    .values({
      name: 'Legacy language profile',
      description: null,
      schemaVersion: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const profileId = Number(profileResult.lastInsertRowid);
  context.database.db
    .insert(profileRules)
    .values(
      legacyLanguageRules().map((rule) => {
        const { type, position, configVersion, config } = rule;
        if (
          !isProfileRuleType(type) ||
          typeof position !== 'number' ||
          typeof configVersion !== 'number' ||
          config === null ||
          typeof config !== 'object' ||
          Array.isArray(config)
        ) {
          throw new Error('Legacy rule fixture is invalid.');
        }
        return {
          profileId,
          type,
          position,
          configVersion,
          configJson: JSON.stringify(config),
          createdAt: now,
          updatedAt: now,
        };
      }),
    )
    .run();
  return profileId;
}

function legacyStorageSnapshot(context: TestContext, profileId: number): unknown {
  const profile = context.database.db
    .select({
      name: profiles.name,
      description: profiles.description,
      schemaVersion: profiles.schemaVersion,
      revision: profiles.revision,
      createdAt: profiles.createdAt,
      updatedAt: profiles.updatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .get();
  const rules = context.database.db
    .select({
      type: profileRules.type,
      position: profileRules.position,
      configVersion: profileRules.configVersion,
      configJson: profileRules.configJson,
      createdAt: profileRules.createdAt,
      updatedAt: profileRules.updatedAt,
    })
    .from(profileRules)
    .where(eq(profileRules.profileId, profileId))
    .all();
  if (!profile || rules.length !== 8) throw new Error('Legacy storage fixture is missing data.');
  return { profile, rules };
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
      expect(created.rules[0]).toMatchObject({
        configVersion: 2,
        config: { importance: 'high', preferredLanguages: ['fr', 'en'] },
      });
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

  it('reads a persisted Language V1 profile without modifying legacy data', async () => {
    context = createTestContext();
    const profileId = insertLegacyProfile(context);
    const before = structuredClone(legacyStorageSnapshot(context, profileId));

    const fetched = await context.app.inject({
      method: 'GET',
      url: `/api/profiles/${String(profileId)}`,
    });
    expect(fetched.statusCode).toBe(200);
    const legacyProfile = fetched.json<ProfileResponse>();
    expect(legacyProfile).toMatchObject({
      id: profileId,
      schemaVersion: 1,
      revision: 1,
    });
    expect(legacyProfile.rules[0]).toMatchObject({
      type: 'language',
      configVersion: 1,
      config: { preferredLanguages: ['fr', 'en'], fallback: 'original' },
    });
    const listed = await context.app.inject({ method: 'GET', url: '/api/profiles' });
    expect(listed.json<{ profiles: ProfileResponse[] }>().profiles).toHaveLength(1);
    expect(legacyStorageSnapshot(context, profileId)).toEqual(before);
  });

  it('updates legacy profile metadata without upgrading or rewriting its Language V1 rules', async () => {
    context = createTestContext();
    const profileId = insertLegacyProfile(context);
    const before = legacyStorageSnapshot(context, profileId) as { rules: unknown };

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/profiles/${String(profileId)}`,
      payload: { name: 'Legacy renamed', description: 'Metadata only' },
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json<ProfileResponse>();
    expect(updated).toMatchObject({
      id: profileId,
      name: 'Legacy renamed',
      description: 'Metadata only',
      schemaVersion: 1,
      revision: 2,
    });
    expect(updated.rules[0]).toMatchObject({
      type: 'language',
      configVersion: 1,
      config: { preferredLanguages: ['fr', 'en'], fallback: 'original' },
    });
    const after = legacyStorageSnapshot(context, profileId) as { rules: unknown };
    expect(after.rules).toEqual(before.rules);
  });

  it('rejects Language V1 on new profile creation and full rule replacement', async () => {
    context = createTestContext();
    const legacyCreate = await context.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { ...profilePayload(), rules: legacyLanguageRules() },
    });
    expect(legacyCreate.statusCode).toBe(400);
    expect(context.database.db.select().from(profiles).all()).toEqual([]);

    const created = await createProfile(context);
    const legacyReplace = await context.app.inject({
      method: 'PUT',
      url: `/api/profiles/${String(created.id)}/rules`,
      payload: { rules: legacyLanguageRules() },
    });
    expect(legacyReplace.statusCode).toBe(400);
    const unchanged = await context.app.inject({
      method: 'GET',
      url: `/api/profiles/${String(created.id)}`,
    });
    expect(unchanged.json<ProfileResponse>()).toEqual(created);
  });

  it('accepts an explicit Language V1 to V2 upgrade and retains V1 for the seven other rules', async () => {
    context = createTestContext();
    const profileId = insertLegacyProfile(context);

    const response = await context.app.inject({
      method: 'PUT',
      url: `/api/profiles/${String(profileId)}/rules`,
      payload: { rules: rulesFrom(profilePayload()) },
    });

    expect(response.statusCode).toBe(200);
    const upgraded = response.json<ProfileResponse>();
    expect(upgraded).toMatchObject({
      id: profileId,
      schemaVersion: 1,
      revision: 2,
    });
    expect(upgraded.rules[0]).toMatchObject({
      type: 'language',
      configVersion: 2,
      config: { importance: 'high', preferredLanguages: ['fr', 'en'] },
    });
    const storedVersions = context.database.db
      .select({ type: profileRules.type, configVersion: profileRules.configVersion })
      .from(profileRules)
      .where(eq(profileRules.profileId, profileId))
      .all();
    expect(storedVersions).toContainEqual({ type: 'language', configVersion: 2 });
    expect(
      storedVersions
        .filter((rule) => rule.type !== 'language')
        .every((rule) => rule.configVersion === 1),
    ).toBe(true);
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

  it('assigns the explicit default profile atomically without inventing a default', async () => {
    context = createTestContext();
    const firstResponse = await context.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { ...profilePayload(), name: 'First profile' },
    });
    const secondResponse = await context.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { ...profilePayload(), name: 'Second profile', isDefault: true },
    });
    const first = firstResponse.json<ProfileResponse>();
    const second = secondResponse.json<ProfileResponse>();

    expect(first.isDefault).toBe(false);
    expect(second.isDefault).toBe(true);

    const switched = await context.app.inject({
      method: 'PATCH',
      url: `/api/profiles/${String(first.id)}`,
      payload: { isDefault: true },
    });
    expect(switched.json<ProfileResponse>()).toMatchObject({
      id: first.id,
      isDefault: true,
      revision: 2,
    });
    const previousDefault = await context.app.inject({
      url: `/api/profiles/${String(second.id)}`,
    });
    expect(previousDefault.json<ProfileResponse>()).toMatchObject({
      id: second.id,
      isDefault: false,
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

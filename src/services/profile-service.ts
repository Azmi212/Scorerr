import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseContext } from '../database/client.js';
import { profileRules, profiles, serviceConnections } from '../database/schema.js';

export const profileRuleTypes = [
  'language',
  'seeders',
  'resolution',
  'source',
  'size',
  'codec',
  'custom_formats',
  'indexer',
] as const;

export type ProfileRuleType = (typeof profileRuleTypes)[number];

export const profileSchemaVersion = 1;
export const profileRuleConfigVersion = 1;

const importanceSchema = z.enum(['low', 'medium', 'high', 'priority']);
const languageCodeSchema = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

const languageConfigSchema = z
  .object({
    preferredLanguages: z.array(languageCodeSchema),
    fallback: z.literal('original'),
  })
  .strict();

const seedersConfigSchema = z
  .object({
    importance: importanceSchema,
    desiredMinimum: z.number().int().nonnegative(),
    requireMinimum: z.boolean(),
  })
  .strict();

const resolutionConfigSchema = z
  .object({
    importance: importanceSchema,
    preferredHeight: z.number().int().positive(),
    desiredMinimumHeight: z.number().int().positive(),
    requireMinimum: z.boolean(),
  })
  .strict();

const sourceConfigSchema = z
  .object({
    importance: importanceSchema,
    preferredSources: z.array(z.string().min(1)),
  })
  .strict();

const sizeConfigSchema = z
  .object({
    importance: importanceSchema,
    desiredMaximumBytes: z.number().int().nonnegative(),
    requireMaximum: z.boolean(),
  })
  .strict();

const codecConfigSchema = z
  .object({
    importance: importanceSchema,
    preferredCodecs: z.array(z.string().min(1)),
  })
  .strict();

const customFormatsConfigSchema = z
  .object({
    importance: importanceSchema,
    useRadarrPreferences: z.boolean(),
  })
  .strict();

const indexerReferenceSchema = z
  .object({
    radarrConnectionId: z.number().int().positive(),
    indexerId: z.union([z.number().int().nonnegative(), z.string().min(1)]),
  })
  .strict();

const indexerConfigSchema = z
  .object({
    importance: importanceSchema,
    preferredIndexers: z.array(indexerReferenceSchema),
    allowOthers: z.boolean(),
  })
  .strict();

const ruleInputBase = {
  position: z.number().int().nonnegative(),
  configVersion: z.literal(profileRuleConfigVersion),
};

export const profileRuleInputSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('language'), ...ruleInputBase, config: languageConfigSchema })
    .strict(),
  z.object({ type: z.literal('seeders'), ...ruleInputBase, config: seedersConfigSchema }).strict(),
  z
    .object({ type: z.literal('resolution'), ...ruleInputBase, config: resolutionConfigSchema })
    .strict(),
  z.object({ type: z.literal('source'), ...ruleInputBase, config: sourceConfigSchema }).strict(),
  z.object({ type: z.literal('size'), ...ruleInputBase, config: sizeConfigSchema }).strict(),
  z.object({ type: z.literal('codec'), ...ruleInputBase, config: codecConfigSchema }).strict(),
  z
    .object({
      type: z.literal('custom_formats'),
      ...ruleInputBase,
      config: customFormatsConfigSchema,
    })
    .strict(),
  z.object({ type: z.literal('indexer'), ...ruleInputBase, config: indexerConfigSchema }).strict(),
]);

export type ProfileRuleInput = z.infer<typeof profileRuleInputSchema>;

function exactRuleSet(rules: ProfileRuleInput[], context: z.RefinementCtx): void {
  const seenTypes = new Set<ProfileRuleType>();
  const seenPositions = new Set<number>();
  for (const [index, rule] of rules.entries()) {
    if (seenTypes.has(rule.type)) {
      context.addIssue({
        code: 'custom',
        message: 'Each rule type may appear only once in a profile',
        path: [index, 'type'],
      });
    }
    seenTypes.add(rule.type);
    if (seenPositions.has(rule.position)) {
      context.addIssue({
        code: 'custom',
        message: 'Each rule position must be unique in a profile',
        path: [index, 'position'],
      });
    }
    seenPositions.add(rule.position);
  }
  for (const type of profileRuleTypes) {
    if (!seenTypes.has(type)) {
      context.addIssue({
        code: 'custom',
        message: `Profile is missing the ${type} rule`,
      });
    }
  }
}

const exactProfileRulesSchema = z
  .array(profileRuleInputSchema)
  .length(profileRuleTypes.length)
  .superRefine(exactRuleSet);

const profileNameSchema = z.string().trim().min(1);

export const createProfileRequestSchema = z
  .object({
    name: profileNameSchema,
    description: z.string().nullable().optional(),
    rules: exactProfileRulesSchema,
  })
  .strict();

export const patchProfileRequestSchema = z
  .object({
    name: profileNameSchema.optional(),
    description: z.string().nullable().optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.description !== undefined, {
    message: 'At least one profile field must be provided',
  });

export const replaceProfileRulesRequestSchema = z
  .object({ rules: exactProfileRulesSchema })
  .strict();

export type CreateProfileInput = z.infer<typeof createProfileRequestSchema>;
export type PatchProfileInput = z.infer<typeof patchProfileRequestSchema>;
export type ReplaceProfileRulesInput = z.infer<typeof replaceProfileRulesRequestSchema>;

export interface ProfileView {
  id: number;
  name: string;
  description: string | null;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  rules: ProfileRuleInput[];
}

export class ProfileServiceError extends Error {
  constructor(
    public readonly code: 'profile_not_found' | 'invalid_indexer_connection',
    public readonly statusCode: 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileServiceError';
  }
}

export class ProfileService {
  constructor(private readonly database: DatabaseContext) {}

  list(): ProfileView[] {
    return this.database.db
      .select()
      .from(profiles)
      .orderBy(asc(profiles.id))
      .all()
      .map((profile) => this.serializeProfile(profile));
  }

  get(profileId: number): ProfileView {
    return this.serializeProfile(this.requireProfile(profileId));
  }

  create(input: CreateProfileInput): ProfileView {
    let profileId: number | undefined;
    this.database.sqlite.transaction(() => {
      this.assertIndexerConnections(input.rules);
      const now = new Date();
      const inserted = this.database.db
        .insert(profiles)
        .values({
          name: input.name,
          description: input.description ?? null,
          schemaVersion: profileSchemaVersion,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      profileId = Number(inserted.lastInsertRowid);
      this.insertRules(profileId, input.rules, now);
    })();
    if (profileId === undefined) throw new Error('Profile creation invariant violated');
    return this.get(profileId);
  }

  update(profileId: number, input: PatchProfileInput): ProfileView {
    this.database.sqlite.transaction(() => {
      const profile = this.requireProfile(profileId);
      const now = new Date();
      this.database.db
        .update(profiles)
        .set({
          name: input.name ?? profile.name,
          description: input.description === undefined ? profile.description : input.description,
          revision: profile.revision + 1,
          updatedAt: now,
        })
        .where(eq(profiles.id, profileId))
        .run();
    })();
    return this.get(profileId);
  }

  replaceRules(profileId: number, input: ReplaceProfileRulesInput): ProfileView {
    this.database.sqlite.transaction(() => {
      const profile = this.requireProfile(profileId);
      this.assertIndexerConnections(input.rules);
      const now = new Date();
      this.database.db.delete(profileRules).where(eq(profileRules.profileId, profileId)).run();
      this.insertRules(profileId, input.rules, now);
      this.database.db
        .update(profiles)
        .set({ revision: profile.revision + 1, updatedAt: now })
        .where(eq(profiles.id, profileId))
        .run();
    })();
    return this.get(profileId);
  }

  delete(profileId: number): void {
    const deleted = this.database.db.delete(profiles).where(eq(profiles.id, profileId)).run();
    if (deleted.changes === 0)
      throw new ProfileServiceError('profile_not_found', 404, 'Profile was not found');
  }

  private requireProfile(profileId: number): typeof profiles.$inferSelect {
    const profile = this.database.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .get();
    if (!profile) throw new ProfileServiceError('profile_not_found', 404, 'Profile was not found');
    return profile;
  }

  private serializeProfile(profile: typeof profiles.$inferSelect): ProfileView {
    const rules = this.database.db
      .select()
      .from(profileRules)
      .where(eq(profileRules.profileId, profile.id))
      .orderBy(asc(profileRules.position), asc(profileRules.id))
      .all()
      .map((rule) => {
        const parsed = profileRuleInputSchema.safeParse({
          type: rule.type,
          position: rule.position,
          configVersion: rule.configVersion,
          config: JSON.parse(rule.configJson) as unknown,
        });
        if (!parsed.success) throw new Error('Stored profile rule is invalid');
        return parsed.data;
      });
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      schemaVersion: profile.schemaVersion,
      revision: profile.revision,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      rules,
    };
  }

  private insertRules(profileId: number, rules: ProfileRuleInput[], now: Date): void {
    this.database.db
      .insert(profileRules)
      .values(
        rules.map((rule) => ({
          profileId,
          type: rule.type,
          position: rule.position,
          configVersion: rule.configVersion,
          configJson: JSON.stringify(rule.config),
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
  }

  private assertIndexerConnections(rules: ProfileRuleInput[]): void {
    const connectionIds = [
      ...new Set(
        rules.flatMap((rule) =>
          rule.type === 'indexer'
            ? rule.config.preferredIndexers.map((reference) => reference.radarrConnectionId)
            : [],
        ),
      ),
    ];
    if (connectionIds.length === 0) return;
    const connections = this.database.db
      .select({ id: serviceConnections.id, service: serviceConnections.service })
      .from(serviceConnections)
      .where(inArray(serviceConnections.id, connectionIds))
      .all();
    const radarrConnectionIds = new Set(
      connections
        .filter((connection) => connection.service === 'radarr')
        .map((connection) => connection.id),
    );
    if (connectionIds.some((connectionId) => !radarrConnectionIds.has(connectionId))) {
      throw new ProfileServiceError(
        'invalid_indexer_connection',
        422,
        'Each preferred indexer must reference an existing Radarr connection',
      );
    }
  }
}

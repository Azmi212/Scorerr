import { describe, expect, it } from 'vitest';

import {
  profileRuleInputSchema,
  replaceProfileRulesRequestSchema,
} from '../src/services/profile-service.js';

function validRules(): unknown[] {
  return [
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
  ];
}

describe('Profile rule configuration schemas', () => {
  it('accepts the eight typed, versioned rule configurations', () => {
    for (const rule of validRules())
      expect(profileRuleInputSchema.safeParse(rule).success).toBe(true);
  });

  it('preserves preferred language order and requires the original-version fallback', () => {
    const rule = validRules()[0];
    const parsed = profileRuleInputSchema.parse(rule);
    expect(parsed).toMatchObject({
      config: { preferredLanguages: ['fr', 'en'], fallback: 'original' },
    });
    expect(
      profileRuleInputSchema.safeParse({
        ...parsed,
        config: { preferredLanguages: ['fr'], fallback: 'translated' },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown properties in every rule configuration', () => {
    for (const rule of validRules()) {
      const candidate = structuredClone(rule) as {
        config: Record<string, unknown>;
      };
      candidate.config.unexpected = true;
      expect(profileRuleInputSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('validates seeders and resolution as semantic integer thresholds', () => {
    const rules = validRules() as {
      type: string;
      position: number;
      configVersion: number;
      config: Record<string, unknown>;
    }[];
    const seeders = rules.find((rule) => rule.type === 'seeders');
    const resolution = rules.find((rule) => rule.type === 'resolution');
    if (!seeders || !resolution) throw new Error('Rule fixture invariant violated');
    expect(
      profileRuleInputSchema.safeParse({
        ...seeders,
        config: { ...seeders.config, desiredMinimum: -1 },
      }).success,
    ).toBe(false);
    expect(
      profileRuleInputSchema.safeParse({
        ...seeders,
        config: { ...seeders.config, desiredMinimum: 2.5 },
      }).success,
    ).toBe(false);
    expect(
      profileRuleInputSchema.safeParse({
        ...resolution,
        config: { ...resolution.config, preferredHeight: '2160p (4K)' },
      }).success,
    ).toBe(false);
  });

  it('stores size in bytes and rejects UI-only units or unknown config versions', () => {
    const rules = validRules() as {
      type: string;
      position: number;
      configVersion: number;
      config: Record<string, unknown>;
    }[];
    const size = rules.find((rule) => rule.type === 'size');
    if (!size) throw new Error('Rule fixture invariant violated');
    expect(
      profileRuleInputSchema.safeParse({
        ...size,
        config: { ...size.config, desiredMaximumGiB: 10 },
      }).success,
    ).toBe(false);
    expect(profileRuleInputSchema.safeParse({ ...size, configVersion: 2 }).success).toBe(false);
  });

  it('requires one ordered instance of every rule type and unique positions', () => {
    const rules = validRules();
    expect(replaceProfileRulesRequestSchema.safeParse({ rules }).success).toBe(true);
    const duplicateType = structuredClone(rules) as Record<string, unknown>[];
    duplicateType[7] = { ...duplicateType[7], type: 'language' };
    expect(replaceProfileRulesRequestSchema.safeParse({ rules: duplicateType }).success).toBe(
      false,
    );
    const duplicatePosition = structuredClone(rules) as Record<string, unknown>[];
    duplicatePosition[7] = { ...duplicatePosition[7], position: 0 };
    expect(replaceProfileRulesRequestSchema.safeParse({ rules: duplicatePosition }).success).toBe(
      false,
    );
  });
});

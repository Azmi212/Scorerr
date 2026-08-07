import { z } from 'zod';

import { ServiceClientError } from '../security/redaction.js';

const instanceSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    hostname: z.string(),
    port: z.number().int(),
    apiKey: z.string().optional(),
    useSsl: z.boolean(),
    baseUrl: z.string().optional(),
    active: z.boolean().optional(),
    is4k: z.boolean().optional(),
    preventSearch: z.boolean(),
  })
  .loose();

export type SeerrRadarrInstance = z.infer<typeof instanceSchema>;

export function parseSeerrInstances(value: unknown): SeerrRadarrInstance[] {
  const parsed = z.array(instanceSchema).safeParse(value);
  if (!parsed.success)
    throw new ServiceClientError(
      'incompatible_response',
      'Seerr Radarr settings response is incompatible',
    );
  return parsed.data;
}

export function instanceUrl(instance: SeerrRadarrInstance): string {
  const base = instance.baseUrl?.replace(/^\/+|\/+$/g, '');
  return `${instance.useSsl ? 'https' : 'http'}://${instance.hostname}:${String(instance.port)}${base ? `/${base}` : ''}`;
}

const writableFields = [
  'name',
  'hostname',
  'port',
  'apiKey',
  'useSsl',
  'baseUrl',
  'active',
  'activeProfileId',
  'activeProfileName',
  'activeDirectory',
  'is4k',
  'minimumAvailability',
  'isDefault',
  'externalUrl',
  'syncEnabled',
  'preventSearch',
] as const;

export function buildSeerrUpdate(
  instance: SeerrRadarrInstance,
  preventSearch: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of writableFields) {
    if (instance[field] !== undefined) result[field] = instance[field];
  }
  if (!('apiKey' in result))
    throw new ServiceClientError(
      'unsupported_version',
      'Seerr did not provide a required writable configuration field',
    );
  result.preventSearch = preventSearch;
  return result;
}

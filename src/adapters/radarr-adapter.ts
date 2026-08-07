import { z } from 'zod';

import { ServiceClientError } from '../security/redaction.js';

const statusSchema = z
  .object({ version: z.string().min(1), instanceName: z.string().optional() })
  .loose();
const notificationSchema = z
  .object({
    id: z.number().int(),
    name: z.string().optional(),
    implementation: z.string().optional(),
    configContract: z.string().optional(),
    onMovieAdded: z.boolean().optional(),
    supportsOnMovieAdded: z.boolean().optional(),
    fields: z
      .array(z.object({ name: z.string(), value: z.unknown().optional() }).loose())
      .optional(),
  })
  .loose();

export type RadarrNotification = z.infer<typeof notificationSchema>;

export function parseRadarrStatus(value: unknown): { version: string; instanceName?: string } {
  const result = statusSchema.safeParse(value);
  if (!result.success)
    throw new ServiceClientError('incompatible_response', 'Radarr status response is incompatible');
  return {
    version: result.data.version,
    ...(result.data.instanceName === undefined ? {} : { instanceName: result.data.instanceName }),
  };
}

export function parseNotifications(value: unknown): RadarrNotification[] {
  const result = z.array(notificationSchema).safeParse(value);
  if (!result.success)
    throw new ServiceClientError(
      'incompatible_response',
      'Radarr notification response is incompatible',
    );
  return result.data;
}

function fieldValue(notification: RadarrNotification, name: string): unknown {
  return notification.fields?.find((field) => field.name === name)?.value;
}

export function findScorerrWebhook(
  notifications: RadarrNotification[],
  callbackUrl: string,
): RadarrNotification | undefined {
  return notifications.find(
    (notification) =>
      notification.implementation === 'Webhook' &&
      notification.onMovieAdded === true &&
      fieldValue(notification, 'url') === callbackUrl,
  );
}

export type WebhookState =
  | 'managed_exact'
  | 'preexisting_exact'
  | 'preexisting_compatible_extra_triggers'
  | 'missing'
  | 'conflict';

export interface WebhookClassification {
  state: WebhookState;
  notification?: RadarrNotification;
  extraTriggers: string[];
}

function enabledTriggers(notification: RadarrNotification): string[] {
  return Object.entries(notification)
    .filter(([key, value]) => /^on[A-Z]/.test(key) && value === true)
    .map(([key]) => key)
    .sort();
}

export function classifyScorerrWebhook(
  notifications: RadarrNotification[],
  callbackUrl: string,
  managedExternalIds: ReadonlySet<number>,
): WebhookClassification {
  const matchingUrl = notifications.filter(
    (notification) => fieldValue(notification, 'url') === callbackUrl,
  );
  const compatible = matchingUrl.find(
    (notification) =>
      notification.implementation === 'Webhook' && notification.onMovieAdded === true,
  );
  if (compatible) {
    const extraTriggers = enabledTriggers(compatible).filter((key) => key !== 'onMovieAdded');
    if (managedExternalIds.has(compatible.id))
      return {
        state: extraTriggers.length === 0 ? 'managed_exact' : 'conflict',
        notification: compatible,
        extraTriggers,
      };
    return {
      state:
        extraTriggers.length === 0 ? 'preexisting_exact' : 'preexisting_compatible_extra_triggers',
      notification: compatible,
      extraTriggers,
    };
  }
  const namedConflict = notifications.find(
    (notification) => notification.name === 'scorerr-movie-added',
  );
  const conflict = matchingUrl[0] ?? namedConflict;
  return conflict
    ? { state: 'conflict', notification: conflict, extraTriggers: [] }
    : { state: 'missing', extraTriggers: [] };
}

const schemaField = z.object({ name: z.string(), value: z.unknown().optional() }).loose();
const providerSchema = z
  .object({
    name: z.string(),
    implementation: z.string(),
    configContract: z.string(),
    fields: z.array(schemaField),
  })
  .loose();

export function buildWebhookPayload(
  rawSchemas: unknown,
  callbackUrl: string,
): Record<string, unknown> {
  const parsed = z.array(providerSchema).safeParse(rawSchemas);
  if (!parsed.success)
    throw new ServiceClientError(
      'unsupported_version',
      'Radarr notification schema is unsupported',
    );
  const webhook = parsed.data.find((item) => item.implementation === 'Webhook');
  const requiredFields = ['url', 'method', 'username', 'password', 'headers'];
  if (
    webhook?.configContract !== 'WebhookSettings' ||
    !requiredFields.every((name) => webhook.fields.some((field) => field.name === name)) ||
    webhook.onMovieAdded === undefined ||
    webhook.supportsOnMovieAdded !== true
  ) {
    throw new ServiceClientError('unsupported_version', 'Radarr webhook schema is unavailable');
  }
  const payload = Object.fromEntries(
    Object.entries(webhook).filter(
      ([key, value]) =>
        [
          'name',
          'implementation',
          'configContract',
          'infoLink',
          'message',
          'tags',
          'fields',
        ].includes(key) ||
        (/^(on|supportsOn)[A-Z]/.test(key) && typeof value === 'boolean'),
    ),
  );
  payload.name = 'scorerr-movie-added';
  for (const [key, value] of Object.entries(payload)) {
    if (/^on[A-Z]/.test(key) && typeof value === 'boolean') payload[key] = false;
  }
  payload.onMovieAdded = true;
  payload.fields = webhook.fields.map((field) => ({
    ...field,
    value: field.name === 'url' ? callbackUrl : field.name === 'method' ? 1 : field.value,
  }));
  return payload;
}

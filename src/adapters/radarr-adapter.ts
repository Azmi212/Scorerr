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
    onMovieAdded: z.boolean().optional(),
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

const schemaField = z.object({ name: z.string(), value: z.unknown().optional() }).loose();
const providerSchema = z
  .object({ implementation: z.string(), fields: z.array(schemaField) })
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
  if (!webhook?.fields.some((field) => field.name === 'url')) {
    throw new ServiceClientError('unsupported_version', 'Radarr webhook schema is unavailable');
  }
  return {
    name: 'scorerr-movie-added',
    implementation: 'Webhook',
    configContract: 'WebhookSettings',
    onGrab: false,
    onDownload: false,
    onUpgrade: false,
    onRename: false,
    onMovieAdded: true,
    onMovieDelete: false,
    onMovieFileDelete: false,
    onMovieFileDeleteForUpgrade: false,
    onHealthIssue: false,
    onHealthRestored: false,
    onApplicationUpdate: false,
    includeHealthWarnings: false,
    tags: [],
    fields: webhook.fields.map((field) => ({
      ...field,
      value: field.name === 'url' ? callbackUrl : field.value,
    })),
  };
}

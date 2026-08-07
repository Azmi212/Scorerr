import { eq } from 'drizzle-orm';

import type { DatabaseContext } from '../database/client.js';
import { events, tasks, webhookDeliveries } from '../database/schema.js';
import { fingerprintEvent, sha256 } from './fingerprint.js';

export interface WebhookResult {
  accepted: true;
  duplicate: boolean;
  eventId: number;
  deliveryId: number;
  taskId?: number;
}

function getEventType(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const eventType = (payload as Record<string, unknown>).eventType;
  return typeof eventType === 'string' ? eventType : null;
}

export function recordWebhook(
  database: DatabaseContext,
  payloadRaw: string,
  payload: unknown,
): WebhookResult {
  const payloadRawHash = sha256(payloadRaw);
  const eventFingerprint = fingerprintEvent(payload);
  const eventType = getEventType(payload);
  const now = new Date();

  return database.sqlite.transaction((): WebhookResult => {
    const insertResult = database.db
      .insert(events)
      .values({
        source: 'radarr',
        eventType,
        payloadRaw,
        payloadRawHash,
        eventFingerprint,
        receivedAt: now,
      })
      .onConflictDoNothing({ target: events.eventFingerprint })
      .run();

    const [event] = database.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.eventFingerprint, eventFingerprint))
      .limit(1)
      .all();

    if (!event) throw new Error('Event insertion could not be verified');
    const duplicate = insertResult.changes === 0;
    const deliveryResult = database.db
      .insert(webhookDeliveries)
      .values({
        source: 'radarr',
        eventType,
        eventId: event.id,
        eventFingerprint,
        payloadRawHash,
        duplicate,
        receivedAt: now,
      })
      .run();
    const deliveryId = Number(deliveryResult.lastInsertRowid);
    if (duplicate) return { accepted: true, duplicate: true, eventId: event.id, deliveryId };

    const taskResult = database.db
      .insert(tasks)
      .values({
        eventId: event.id,
        status: 'pending',
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return {
      accepted: true,
      duplicate: false,
      eventId: event.id,
      deliveryId,
      taskId: Number(taskResult.lastInsertRowid),
    };
  })();
}

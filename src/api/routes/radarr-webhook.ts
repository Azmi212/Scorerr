import type { FastifyInstance } from 'fastify';

import type { DatabaseContext } from '../../database/client.js';
import { recordWebhook } from '../../services/webhook-service.js';

export function registerWebhookRoutes(app: FastifyInstance, database: DatabaseContext): void {
  app.post('/api/webhooks/radarr', async (request, reply) => {
    const result = recordWebhook(database, request.rawBody, request.body);
    request.log.info(
      {
        eventId: result.eventId,
        deliveryId: result.deliveryId,
        taskId: result.taskId,
        duplicate: result.duplicate,
      },
      'webhook accepted',
    );
    return reply.code(202).send(result);
  });
}

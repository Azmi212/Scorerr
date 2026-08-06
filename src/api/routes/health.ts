import type { FastifyInstance } from 'fastify';

import type { DatabaseContext } from '../../database/client.js';

export function registerHealthRoutes(app: FastifyInstance, database: DatabaseContext): void {
  app.get('/health', async (_request, reply) => {
    try {
      database.sqlite.prepare('SELECT 1').get();
      return { status: 'ok', database: 'reachable' };
    } catch {
      return reply.code(503).send({ status: 'error', database: 'unreachable' });
    }
  });
}

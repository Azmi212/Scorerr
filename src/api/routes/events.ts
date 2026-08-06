import { count, desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { DatabaseContext } from '../../database/client.js';
import { events } from '../../database/schema.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerEventRoutes(app: FastifyInstance, database: DatabaseContext): void {
  app.get('/api/events', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid pagination parameters' });
    }

    const countRows = database.db.select({ total: count() }).from(events).all();
    const total = countRows[0]?.total ?? 0;
    const items = database.db
      .select()
      .from(events)
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(parsed.data.limit)
      .offset(parsed.data.offset)
      .all();
    return { items, total, limit: parsed.data.limit, offset: parsed.data.offset };
  });
}

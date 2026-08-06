import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.js';
import type { DatabaseContext } from '../database/client.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/radarr-webhook.js';

export interface AppDependencies {
  config: AppConfig;
  database: DatabaseContext;
}

export function buildApp({ config, database }: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    bodyLimit: config.BODY_LIMIT_BYTES,
  });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const rawBody = body.toString('utf8');
    request.rawBody = rawBody;
    try {
      done(null, JSON.parse(rawBody) as unknown);
    } catch (error) {
      const parseError = error as Error & { statusCode: number };
      parseError.statusCode = 400;
      done(parseError, undefined);
    }
  });

  registerHealthRoutes(app, database);
  registerWebhookRoutes(app, database);
  registerEventRoutes(app, database);
  return app;
}

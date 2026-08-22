import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.js';
import type { DatabaseContext } from '../database/client.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/radarr-webhook.js';
import { registerReleaseProbeRoutes } from './routes/release-probe.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerSetupRoutes } from './routes/setup.js';
import { SqliteSecretStore } from '../security/secret-store.js';
import { InstallationService } from '../services/installation-service.js';
import { ProfileService } from '../services/profile-service.js';
import { ReleaseProbeService } from '../services/release-probe-service.js';

export interface AppDependencies {
  config: AppConfig;
  database: DatabaseContext;
  installationService?: InstallationService;
  profileService?: ProfileService;
  releaseProbeService?: ReleaseProbeService;
}

export function buildApp({
  config,
  database,
  installationService,
  profileService,
  releaseProbeService,
}: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.x-api-key',
              'req.headers.authorization',
              '*.apiKey',
              '*.secret',
              '*.ciphertext',
            ],
          },
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
  const secretStore = new SqliteSecretStore(
    database,
    config.DATABASE_PATH,
    config.SCORERR_MASTER_KEY,
  );
  const setupService =
    installationService ?? new InstallationService(database, config, secretStore);
  registerSetupRoutes(app, setupService);
  registerReleaseProbeRoutes(
    app,
    releaseProbeService ?? new ReleaseProbeService(database, config, secretStore),
  );
  registerProfileRoutes(app, profileService ?? new ProfileService(database));
  return app;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/api/app.js';
import type { AppConfig } from '../src/config/env.js';
import { createDatabase, type DatabaseContext } from '../src/database/client.js';
import { applyMigrations } from '../src/database/migrate.js';

export interface TestContext {
  app: FastifyInstance;
  database: DatabaseContext;
  cleanup: () => Promise<void>;
}

export function createTestContext(frontendRoot?: string | false): TestContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-test-'));
  const database = createDatabase(path.join(directory, 'test.db'));
  applyMigrations(database);
  const config: AppConfig = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    DATABASE_PATH: path.join(directory, 'test.db'),
    LOG_LEVEL: 'silent',
    BODY_LIMIT_BYTES: 1024 * 1024,
    SCORERR_PUBLIC_URL: 'http://scorerr:3000',
    HTTP_TIMEOUT_MS: 5000,
    HTTP_MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
    SETUP_DIAGNOSTIC_TTL_MS: 300_000,
    SETUP_WRITES_ENABLED: false,
    SETUP_NON_PERSISTENT_TESTS_ENABLED: false,
    SETUP_SEERR_PROBE_WRITE_ENABLED: false,
    RELEASE_PROBE_ENABLED: false,
    RELEASE_PROBE_TIMEOUT_MS: 120_000,
    RELEASE_PROBE_COOLDOWN_MS: 30_000,
    WORKER_POLL_INTERVAL_MS: 100,
    WORKER_SCHEMA_WAIT_INTERVAL_MS: 100,
    WORKER_LOCK_TIMEOUT_MS: 300_000,
    WORKER_MAX_ATTEMPTS: 3,
  };
  const app = buildApp({
    config,
    database,
    ...(frontendRoot === undefined ? {} : { frontendRoot }),
  });

  return {
    app,
    database,
    cleanup: async () => {
      await app.close();
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

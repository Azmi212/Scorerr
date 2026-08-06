import fs from 'node:fs';

import { z } from 'zod';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default('./data/scorerr.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(1024 * 1024),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  WORKER_SCHEMA_WAIT_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  WORKER_LOCK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(300_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(3),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(source);
}

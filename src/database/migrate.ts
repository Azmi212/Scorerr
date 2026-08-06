import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { DatabaseContext } from './client.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

export function applyMigrations(database: DatabaseContext): void {
  migrate(database.db, { migrationsFolder });
}

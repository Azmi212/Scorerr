import fs from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type DatabaseContext = ReturnType<typeof createDatabase>;

export function createDatabase(databasePath: string) {
  const directory = path.dirname(path.resolve(databasePath));
  fs.mkdirSync(directory, { recursive: true });

  const sqlite = new BetterSqlite3(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  };
}

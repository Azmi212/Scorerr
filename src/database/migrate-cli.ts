import { loadConfig } from '../config/env.js';
import { createDatabase } from './client.js';
import { applyMigrations } from './migrate.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_PATH);

try {
  applyMigrations(database);
  console.log(JSON.stringify({ level: 'info', message: 'Database migrations applied' }));
} finally {
  database.close();
}

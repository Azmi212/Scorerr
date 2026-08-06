import { loadConfig } from '../config/env.js';
import { createDatabase } from '../database/client.js';
import { applyMigrations } from '../database/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_PATH);
applyMigrations(database);

const app = buildApp({ config, database });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  database.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  database.close();
  process.exit(1);
}

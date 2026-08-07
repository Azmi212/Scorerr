import { randomUUID } from 'node:crypto';
import os from 'node:os';

import pino from 'pino';

import { loadConfig } from '../config/env.js';
import { createDatabase } from '../database/client.js';
import {
  claimNextTask,
  completeProbeTask,
  recoverAbandonedTasks,
  schemaIsReady,
} from '../services/task-service.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const workerId = `${os.hostname()}-${String(process.pid)}-${randomUUID()}`;
const database = createDatabase(config.DATABASE_PATH);
let stopping = false;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run(): Promise<void> {
  while (!stopping && !schemaIsReady(database)) {
    log.info({ workerId }, 'waiting for API database migrations');
    await wait(config.WORKER_SCHEMA_WAIT_INTERVAL_MS);
  }

  log.info({ workerId }, 'worker ready');
  while (!stopping) {
    const recovery = recoverAbandonedTasks(
      database,
      config.WORKER_LOCK_TIMEOUT_MS,
      config.WORKER_MAX_ATTEMPTS,
    );
    if (recovery.requeued > 0 || recovery.failed > 0) {
      log.info({ workerId, ...recovery }, 'expired task locks recovered');
    }

    const task = claimNextTask(database, workerId);
    if (!task) {
      await wait(config.WORKER_POLL_INTERVAL_MS);
      continue;
    }

    log.info({ workerId, taskId: task.id, eventId: task.eventId }, 'probe task claimed');
    const completed = completeProbeTask(database, task.id, workerId);
    if (!completed) log.error({ workerId, taskId: task.id }, 'probe task completion rejected');
    else log.info({ workerId, taskId: task.id }, 'probe task completed');
  }
}

function shutdown(signal: string): void {
  stopping = true;
  log.info({ signal, workerId }, 'worker stopping');
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

try {
  await run();
  database.close();
} catch (error) {
  log.error({ error, workerId }, 'worker failed');
  database.close();
  process.exit(1);
}

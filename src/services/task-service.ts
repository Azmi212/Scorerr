import type { DatabaseContext } from '../database/client.js';
import type { Task } from '../database/schema.js';

type StoredTask = Omit<
  Task,
  'availableAt' | 'lockedAt' | 'completedAt' | 'createdAt' | 'updatedAt'
> & {
  availableAt: number;
  lockedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export function claimNextTask(database: DatabaseContext, workerId: string): StoredTask | undefined {
  const now = Date.now();
  return database.sqlite
    .prepare(
      `UPDATE tasks
       SET status = 'processing', locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = (
         SELECT id FROM tasks
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY available_at ASC, id ASC
         LIMIT 1
       ) AND status = 'pending'
       RETURNING
         id, event_id AS eventId, status, attempts, available_at AS availableAt,
         locked_at AS lockedAt, locked_by AS lockedBy, completed_at AS completedAt,
         result, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt`,
    )
    .get(now, workerId, now, now) as StoredTask | undefined;
}

export function completeProbeTask(
  database: DatabaseContext,
  taskId: number,
  workerId: string,
): boolean {
  const now = Date.now();
  return database.sqlite.transaction(() => {
    const event = database.sqlite
      .prepare(
        `SELECT events.event_type AS eventType
         FROM tasks JOIN events ON events.id = tasks.event_id
         WHERE tasks.id = ? AND tasks.status = 'processing' AND tasks.locked_by = ?`,
      )
      .get(taskId, workerId) as { eventType: string | null } | undefined;
    if (!event) return false;
    const probeResult = isOptimizationEligibleEvent(event.eventType)
      ? 'probe_observed_movie_added'
      : 'probe_ignored_non_movie_added';
    const result = database.sqlite
      .prepare(
        `UPDATE tasks
       SET status = 'completed', result = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'processing' AND locked_by = ?`,
      )
      .run(probeResult, now, now, taskId, workerId);
    return result.changes === 1;
  })();
}

export function isOptimizationEligibleEvent(eventType: string | null): boolean {
  return eventType === 'MovieAdded';
}

export interface RecoveryResult {
  requeued: number;
  failed: number;
}

/**
 * Recovers every expired processing lock in one atomic SQLite statement.
 * Attempts are incremented when a task is claimed, not when its lock is recovered.
 */
export function recoverAbandonedTasks(
  database: DatabaseContext,
  lockTimeoutMs: number,
  maxAttempts: number,
  now = Date.now(),
): RecoveryResult {
  const lockExpiredBefore = now - lockTimeoutMs;
  const recovered = database.sqlite
    .prepare(
      `UPDATE tasks
       SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
           available_at = CASE WHEN attempts >= ? THEN available_at ELSE ? END,
           locked_at = NULL,
           locked_by = NULL,
           last_error = CASE
             WHEN attempts >= ? THEN 'maximum_attempts_reached_after_lock_expiry'
             ELSE 'worker_lock_expired'
           END,
           updated_at = ?
       WHERE status = 'processing'
         AND locked_at IS NOT NULL
         AND locked_at <= ?
       RETURNING status`,
    )
    .all(maxAttempts, maxAttempts, now, maxAttempts, now, lockExpiredBefore) as {
    status: 'pending' | 'failed';
  }[];

  return recovered.reduce<RecoveryResult>(
    (result, task) => {
      if (task.status === 'pending') result.requeued += 1;
      else result.failed += 1;
      return result;
    },
    { requeued: 0, failed: 0 },
  );
}

export function schemaIsReady(database: DatabaseContext): boolean {
  const row = database.sqlite
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'tasks')",
    )
    .get() as { count: number };
  return row.count === 2;
}

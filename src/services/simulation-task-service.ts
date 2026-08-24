import type { DatabaseContext } from '../database/client.js';

export type SimulationProgressCode =
  'film_found' | 'releases_retrieved' | 'preferences_analyzed' | 'selection_calculated';

export interface SimulationProgressStep {
  code: SimulationProgressCode;
  label: 'Film trouvé' | 'Releases récupérées' | 'Analyse des préférences' | 'Calcul du classement';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface ClaimedSimulation {
  id: number;
  attempts: number;
  lockedBy: string;
}

export interface SimulationRecoveryResult {
  requeued: number;
  failed: number;
}

const labels: Record<SimulationProgressCode, SimulationProgressStep['label']> = {
  film_found: 'Film trouvé',
  releases_retrieved: 'Releases récupérées',
  preferences_analyzed: 'Analyse des préférences',
  selection_calculated: 'Calcul du classement',
};

export function initialSimulationProgress(): SimulationProgressStep[] {
  return (Object.keys(labels) as SimulationProgressCode[]).map((code) => ({
    code,
    label: labels[code],
    status: 'pending',
    startedAt: null,
    completedAt: null,
    error: null,
  }));
}

export function claimNextSimulation(
  database: DatabaseContext,
  workerId: string,
  now = Date.now(),
): ClaimedSimulation | undefined {
  return database.sqlite
    .prepare(
      `UPDATE simulations
       SET status = 'running', locked_at = ?, locked_by = ?, attempts = attempts + 1,
           started_at = CASE WHEN attempts = 0 THEN ? ELSE started_at END,
           last_error = NULL, error_code = NULL, error_message = NULL
       WHERE id = (
         SELECT id FROM simulations
         WHERE status = 'queued' AND available_at <= ?
         ORDER BY available_at ASC, id ASC
         LIMIT 1
       ) AND status = 'queued'
       RETURNING id, attempts, locked_by AS lockedBy`,
    )
    .get(now, workerId, now, now) as ClaimedSimulation | undefined;
}

function failedProgress(progressJson: string, now: Date): string {
  const progress = JSON.parse(progressJson) as SimulationProgressStep[];
  const active =
    progress.find((step) => step.status === 'in_progress') ??
    progress.find((step) => step.status === 'pending');
  if (active) {
    active.status = 'failed';
    active.completedAt = now.toISOString();
    active.error = {
      code: 'maximum_attempts_reached_after_lock_expiry',
      message: 'Simulation stopped after repeated worker lock expiry',
    };
  }
  return JSON.stringify(progress);
}

export function recoverAbandonedSimulations(
  database: DatabaseContext,
  lockTimeoutMs: number,
  maxAttempts: number,
  nowMs = Date.now(),
): SimulationRecoveryResult {
  const expired = database.sqlite
    .prepare(
      `SELECT id, attempts, progress_json AS progressJson
       FROM simulations
       WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at <= ?`,
    )
    .all(nowMs - lockTimeoutMs) as { id: number; attempts: number; progressJson: string }[];
  const now = new Date(nowMs);
  return database.sqlite.transaction(() => {
    const result = { requeued: 0, failed: 0 };
    for (const simulation of expired) {
      if (simulation.attempts >= maxAttempts) {
        const updated = database.sqlite
          .prepare(
            `UPDATE simulations
             SET status = 'failed', locked_at = NULL, locked_by = NULL,
                 last_error = 'maximum_attempts_reached_after_lock_expiry',
                 error_code = 'maximum_attempts_reached',
                 error_message = 'Simulation stopped after repeated worker lock expiry',
                 progress_json = ?, completed_at = ?
             WHERE id = ? AND status = 'running' AND locked_at <= ?`,
          )
          .run(
            failedProgress(simulation.progressJson, now),
            nowMs,
            simulation.id,
            nowMs - lockTimeoutMs,
          );
        result.failed += updated.changes;
      } else {
        const updated = database.sqlite
          .prepare(
            `UPDATE simulations
             SET status = 'queued', locked_at = NULL, locked_by = NULL,
                 last_error = 'worker_lock_expired', available_at = ?, progress_json = ?
             WHERE id = ? AND status = 'running' AND locked_at <= ?`,
          )
          .run(
            nowMs,
            JSON.stringify(initialSimulationProgress()),
            simulation.id,
            nowMs - lockTimeoutMs,
          );
        result.requeued += updated.changes;
      }
    }
    return result;
  })();
}

export function simulationSchemaIsReady(database: DatabaseContext): boolean {
  return (
    database.sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'simulations'")
      .get() !== undefined
  );
}

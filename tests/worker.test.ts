import { afterEach, describe, expect, it } from 'vitest';

import {
  claimNextTask,
  completeProbeTask,
  recoverAbandonedTasks,
} from '../src/services/task-service.js';
import { recordWebhook } from '../src/services/webhook-service.js';
import { createTestContext, type TestContext } from './helpers.js';

describe('persistent task lifecycle', () => {
  let context: TestContext | undefined;
  afterEach(async () => context?.cleanup());

  it('allows only one worker to claim a task and completes the no-side-effect probe', () => {
    context = createTestContext();
    recordWebhook(context.database, '{"eventType":"Test"}', { eventType: 'Test' });

    const claimed = claimNextTask(context.database, 'worker-a');
    const competingClaim = claimNextTask(context.database, 'worker-b');
    expect(claimed).toMatchObject({ status: 'processing', lockedBy: 'worker-a', attempts: 1 });
    expect(competingClaim).toBeUndefined();
    if (!claimed) throw new Error('Expected worker-a to claim the task');
    expect(completeProbeTask(context.database, claimed.id, 'worker-b')).toBe(false);
    expect(completeProbeTask(context.database, claimed.id, 'worker-a')).toBe(true);

    const task = context.database.sqlite.prepare('SELECT * FROM tasks').get() as {
      status: string;
      result: string;
      completed_at: number;
      locked_at: number;
      locked_by: string;
    };
    expect(task).toMatchObject({
      status: 'completed',
      result: 'probe_observed',
      locked_by: 'worker-a',
    });
    expect(task.locked_at).toBeTypeOf('number');
    expect(task.completed_at).toBeTypeOf('number');
  });

  it('requeues an abandoned task without incrementing its attempts', () => {
    context = createTestContext();
    recordWebhook(context.database, '{"eventType":"Abandoned"}', { eventType: 'Abandoned' });
    const claimed = claimNextTask(context.database, 'worker-lost');
    if (!claimed) throw new Error('Expected the task to be claimed');
    const now = Date.now();
    context.database.sqlite
      .prepare('UPDATE tasks SET locked_at = ? WHERE id = ?')
      .run(now - 301_000, claimed.id);

    expect(recoverAbandonedTasks(context.database, 300_000, 3, now)).toEqual({
      requeued: 1,
      failed: 0,
    });
    expect(
      context.database.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(claimed.id),
    ).toMatchObject({
      status: 'pending',
      attempts: 1,
      locked_at: null,
      locked_by: null,
      last_error: 'worker_lock_expired',
    });
  });

  it('does not recover a task while its lock is still valid', () => {
    context = createTestContext();
    recordWebhook(context.database, '{"eventType":"Active"}', { eventType: 'Active' });
    const claimed = claimNextTask(context.database, 'worker-active');
    if (!claimed) throw new Error('Expected the task to be claimed');
    const now = Date.now();
    context.database.sqlite
      .prepare('UPDATE tasks SET locked_at = ? WHERE id = ?')
      .run(now - 299_999, claimed.id);

    expect(recoverAbandonedTasks(context.database, 300_000, 3, now)).toEqual({
      requeued: 0,
      failed: 0,
    });
    expect(
      context.database.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(claimed.id),
    ).toMatchObject({
      status: 'processing',
      attempts: 1,
      locked_by: 'worker-active',
    });
  });

  it('fails an abandoned task that reached the maximum attempts', () => {
    context = createTestContext();
    recordWebhook(context.database, '{"eventType":"Exhausted"}', { eventType: 'Exhausted' });
    const claimed = claimNextTask(context.database, 'worker-lost');
    if (!claimed) throw new Error('Expected the task to be claimed');
    const now = Date.now();
    context.database.sqlite
      .prepare('UPDATE tasks SET attempts = ?, locked_at = ? WHERE id = ?')
      .run(3, now - 300_001, claimed.id);

    expect(recoverAbandonedTasks(context.database, 300_000, 3, now)).toEqual({
      requeued: 0,
      failed: 1,
    });
    expect(
      context.database.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(claimed.id),
    ).toMatchObject({
      status: 'failed',
      attempts: 3,
      locked_at: null,
      locked_by: null,
      last_error: 'maximum_attempts_reached_after_lock_expiry',
    });
  });
});

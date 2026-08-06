import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './helpers.js';

describe('POST /api/webhooks/radarr', () => {
  let context: TestContext | undefined;
  afterEach(async () => context?.cleanup());

  it('stores the exact payload and creates one persistent task', async () => {
    context = createTestContext();
    const payload = '{\n  "eventType": "Test", "movie": {"id": 42}\n}';
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/webhooks/radarr',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      eventId: 1,
      taskId: 1,
    });
    const event = context.database.sqlite.prepare('SELECT * FROM events').get() as {
      payload_raw: string;
      payload_raw_hash: string;
      event_fingerprint: string;
    };
    expect(event.payload_raw).toBe(payload);
    expect(event.payload_raw_hash).toHaveLength(64);
    expect(event.event_fingerprint).toHaveLength(64);
    expect(context.database.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({
      count: 1,
    });
  });

  it('detects normalized duplicates despite property ordering and whitespace', async () => {
    context = createTestContext();
    const first = await context.app.inject({
      method: 'POST',
      url: '/api/webhooks/radarr',
      headers: { 'content-type': 'application/json' },
      payload: '{"eventType":"Test","movie":{"title":"Demo","id":7}}',
    });
    const duplicate = await context.app.inject({
      method: 'POST',
      url: '/api/webhooks/radarr',
      headers: { 'content-type': 'application/json' },
      payload: '{ "movie": { "id": 7, "title": "Demo" }, "eventType": "Test" }',
    });

    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true, eventId: 1 });
    expect(context.database.sqlite.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({
      count: 1,
    });
    expect(context.database.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({
      count: 1,
    });
  });

  it('rejects malformed JSON and payloads above the configured limit', async () => {
    context = createTestContext();
    const malformed = await context.app.inject({
      method: 'POST',
      url: '/api/webhooks/radarr',
      headers: { 'content-type': 'application/json' },
      payload: '{broken',
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await context.app.inject({
      method: 'POST',
      url: '/api/webhooks/radarr',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
    });
    expect(oversized.statusCode).toBe(413);
  });
});

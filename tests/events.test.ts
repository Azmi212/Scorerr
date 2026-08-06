import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './helpers.js';

describe('GET /api/events', () => {
  let context: TestContext | undefined;
  afterEach(async () => context?.cleanup());

  it('lists received events with pagination metadata', async () => {
    context = createTestContext();
    await context.app.inject({
      method: 'POST',
      url: '/api/webhooks/radarr',
      headers: { 'content-type': 'application/json' },
      payload: '{"eventType":"Test"}',
    });

    const response = await context.app.inject({ method: 'GET', url: '/api/events?limit=10' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      limit: 10,
      offset: 0,
      items: [{ source: 'radarr', eventType: 'Test', payloadRaw: '{"eventType":"Test"}' }],
    });
  });
});

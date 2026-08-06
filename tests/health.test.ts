import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './helpers.js';

describe('GET /health', () => {
  let context: TestContext | undefined;
  afterEach(async () => context?.cleanup());

  it('confirms that the API and database are ready', async () => {
    context = createTestContext();
    const response = await context.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'reachable' });
  });
});

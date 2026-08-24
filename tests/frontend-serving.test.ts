import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveFrontendRoot } from '../src/api/frontend.js';
import { createTestContext, type TestContext } from './helpers.js';

describe('production frontend serving', () => {
  let context: TestContext | undefined;
  let frontendRoot: string | undefined;

  afterEach(async () => {
    await context?.cleanup();
    if (frontendRoot) fs.rmSync(frontendRoot, { recursive: true, force: true });
  });

  function createFrontend() {
    frontendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-web-test-'));
    fs.mkdirSync(path.join(frontendRoot, 'assets'));
    fs.writeFileSync(
      path.join(frontendRoot, 'index.html'),
      '<!doctype html><div id="root">scorerr-spa</div>',
    );
    fs.writeFileSync(path.join(frontendRoot, 'assets', 'app.js'), 'window.scorerr = true;');
    context = createTestContext(frontendRoot);
    return context;
  }

  it('resolves the packaged frontend relative to the server module', () => {
    const expected = fileURLToPath(new URL('../web/dist/', import.meta.url));
    expect(resolveFrontendRoot()).toBe(expected);
  });

  it.each(['/', '/profiles', '/simulation', '/integrations', '/settings', '/unknown-route'])(
    'serves the SPA on a browser refresh for %s',
    async (url) => {
      const current = createFrontend();
      const response = await current.app.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('scorerr-spa');
    },
  );

  it('serves built assets while preserving API and legacy technical routes', async () => {
    const current = createFrontend();
    const asset = await current.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('window.scorerr');

    const health = await current.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', database: 'reachable' });

    const setup = await current.app.inject({ method: 'GET', url: '/setup' });
    expect(setup.statusCode).toBe(200);
    expect(setup.headers['content-type']).toContain('text/html');

    const probe = await current.app.inject({ method: 'GET', url: '/probe/releases' });
    expect(probe.statusCode).toBe(200);
    expect(probe.body).not.toContain('scorerr-spa');
  });

  it('does not turn missing API routes into an HTML response', async () => {
    const current = createFrontend();
    const response = await current.app.inject({
      method: 'GET',
      url: '/api/unknown',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } });
  });
});

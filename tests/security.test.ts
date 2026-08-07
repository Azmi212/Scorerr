/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SafeHttpClient, normalizeServiceUrl } from '../src/clients/http-client.js';
import { createDatabase } from '../src/database/client.js';
import { applyMigrations } from '../src/database/migrate.js';
import { SqliteSecretStore } from '../src/security/secret-store.js';
import { redactProbeData } from '../src/security/probe-redaction.js';

describe('setup transport security', () => {
  it('allows private and Docker HTTP targets but rejects unsafe URL forms', () => {
    expect(normalizeServiceUrl('http://192.168.1.10:7878/')).toBe('http://192.168.1.10:7878');
    expect(normalizeServiceUrl('http://radarr:7878')).toBe('http://radarr:7878');
    expect(() => normalizeServiceUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeServiceUrl('http://user:secret@radarr:7878')).toThrow();
  });
  it('rejects redirects without following them or exposing the key', async () => {
    let receivedKey = '';
    const mockedFetch: typeof fetch = async (_input, init) => {
      receivedKey = new Headers(init?.headers).get('X-Api-Key') ?? '';
      return new Response('', { status: 302, headers: { location: 'http://unknown/' } });
    };
    const client = new SafeHttpClient('http://radarr:7878', 'hidden-key', 'X-Api-Key', {
      timeoutMs: 100,
      maxResponseBytes: 1024,
      fetch: mockedFetch,
    });
    await expect(client.request('GET', '/api/v3/system/status')).rejects.toMatchObject({
      code: 'incompatible_response',
      safeMessage: expect.not.stringContaining('hidden-key'),
    });
    expect(receivedKey).toBe('hidden-key');
  });
  it('classifies timeouts without leaking credentials', async () => {
    const mockedFetch: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }),
      );
    const client = new SafeHttpClient('http://seerr:5055', 'timeout-secret', 'X-Api-Key', {
      timeoutMs: 10,
      maxResponseBytes: 1024,
      fetch: mockedFetch,
    });
    await expect(client.request('GET', '/api/v1/settings/radarr')).rejects.toMatchObject({
      code: 'timeout',
      safeMessage: expect.not.stringContaining('timeout-secret'),
    });
  });
  it('redacts descriptor-style API keys and custom notification headers', () => {
    const result = redactProbeData({
      fields: [
        { name: 'apiKey', value: 'seerr-secret' },
        { name: 'headers', value: 'Authorization: Bearer radarr-secret' },
      ],
    });
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain('seerr-secret');
    expect(serialized).not.toContain('radarr-secret');
    expect(result.sensitiveFields).toHaveLength(2);
  });
});

describe('secret store key safety', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  it('refuses to generate a replacement key when encrypted secrets exist', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorerr-secret-'));
    const dbPath = path.join(directory, 'db.sqlite');
    let database = createDatabase(dbPath);
    applyMigrations(database);
    const store = new SqliteSecretStore(database, dbPath);
    store.put('critical-secret');
    database.close();
    fs.rmSync(path.join(directory, 'scorerr-master.key'));
    database = createDatabase(dbPath);
    expect(() => new SqliteSecretStore(database, dbPath)).toThrow('key is missing');
    database.close();
  });
});

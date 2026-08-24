import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const RESERVED_PREFIXES = ['/api/', '/health', '/setup', '/probe/releases'];
const DEFAULT_FRONTEND_ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export interface FrontendOptions {
  root?: string | false;
}

export function resolveFrontendRoot(root?: string | false): string | null {
  if (root === false) return null;
  return root ?? DEFAULT_FRONTEND_ROOT;
}

export function registerFrontend(app: FastifyInstance, options: FrontendOptions = {}): void {
  const root = resolveFrontendRoot(options.root);
  if (!root || !existsSync(resolve(root, 'index.html'))) return;

  void app.register(fastifyStatic, {
    root,
    wildcard: false,
    etag: true,
    maxAge: '1h',
    immutable: false,
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
    const reserved = RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));

    if (request.method === 'GET' && acceptsHtml && !reserved) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }

    return reply.code(404).send({
      error: {
        code: 'not_found',
        message: 'Route not found',
      },
    });
  });
}

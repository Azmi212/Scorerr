import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  createProfileRequestSchema,
  patchProfileRequestSchema,
  ProfileServiceError,
  replaceProfileRulesRequestSchema,
  type ProfileService,
} from '../../services/profile-service.js';

const profileParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();

function invalidRequest(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(400).send({ error });
}

function profileServiceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof ProfileServiceError)
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  throw error;
}

export function registerProfileRoutes(app: FastifyInstance, service: ProfileService): void {
  app.get('/api/profiles', () => ({ profiles: service.list() }));

  app.post('/api/profiles', (request, reply) => {
    const parsed = createProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, 'Invalid profile payload');
    try {
      return reply.code(201).send(service.create(parsed.data));
    } catch (error) {
      return profileServiceError(error, reply);
    }
  });

  app.get('/api/profiles/:id', (request, reply) => {
    const parsed = profileParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, 'Invalid profile id');
    try {
      return service.get(parsed.data.id);
    } catch (error) {
      return profileServiceError(error, reply);
    }
  });

  app.patch('/api/profiles/:id', (request, reply) => {
    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, 'Invalid profile id');
    const body = patchProfileRequestSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, 'Invalid profile update payload');
    try {
      return service.update(params.data.id, body.data);
    } catch (error) {
      return profileServiceError(error, reply);
    }
  });

  app.put('/api/profiles/:id/rules', (request, reply) => {
    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, 'Invalid profile id');
    const body = replaceProfileRulesRequestSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, 'Invalid profile rules payload');
    try {
      return service.replaceRules(params.data.id, body.data);
    } catch (error) {
      return profileServiceError(error, reply);
    }
  });

  app.delete('/api/profiles/:id', (request, reply) => {
    const parsed = profileParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, 'Invalid profile id');
    try {
      service.delete(parsed.data.id);
      return reply.code(204).send();
    } catch (error) {
      return profileServiceError(error, reply);
    }
  });
}

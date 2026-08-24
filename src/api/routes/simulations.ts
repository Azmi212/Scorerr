import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { ServiceClientError } from '../../security/redaction.js';
import { ProfileServiceError } from '../../services/profile-service.js';
import {
  SimulationServiceError,
  startSimulationRequestSchema,
  type SimulationService,
} from '../../services/simulation-service.js';

const simulationParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();
const moviesQuerySchema = z
  .object({ radarrConnectionId: z.coerce.number().int().positive().optional() })
  .strict();

function serviceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof SimulationServiceError || error instanceof ProfileServiceError) {
    return reply.code(error.statusCode).send({
      code: error.code,
      error: error.message,
      ...('details' in error && error.details !== undefined ? { details: error.details } : {}),
    });
  }
  if (error instanceof ServiceClientError) {
    return reply.code(error.httpStatus ?? 502).send({ code: error.code, error: error.safeMessage });
  }
  throw error;
}

export function registerSimulationRoutes(app: FastifyInstance, service: SimulationService): void {
  app.get('/api/simulations/movies', async (request, reply) => {
    const query = moviesQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid simulation movie query' });
    try {
      return await service.movies(query.data.radarrConnectionId);
    } catch (error) {
      return serviceError(error, reply);
    }
  });

  app.get('/api/simulations', () => service.list());

  app.post('/api/simulations', (request, reply) => {
    const body = startSimulationRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid simulation payload' });
    try {
      return reply.code(202).send(service.create(body.data));
    } catch (error) {
      return serviceError(error, reply);
    }
  });

  app.get('/api/simulations/:id', (request, reply) => {
    const params = simulationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid simulation id' });
    try {
      return service.get(params.data.id);
    } catch (error) {
      return serviceError(error, reply);
    }
  });
}

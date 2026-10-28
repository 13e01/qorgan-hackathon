import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@qorgan/shared';
import { schemaVersion, type Db } from '../db/connection';

export function healthRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    app.get('/api/health', async (): Promise<HealthResponse> => {
      const stations = Number(db.prepare('SELECT COUNT(*) AS n FROM stations').get()?.n ?? 0);
      return {
        status: 'ok',
        time: new Date().toISOString(),
        db: { schemaVersion: schemaVersion(db), stations },
      };
    });
  };
}

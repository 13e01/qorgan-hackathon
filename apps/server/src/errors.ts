import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiError } from '@qorgan/shared';
import type { z } from 'zod';

/** Ожидаемая ошибка с HTTP-статусом и кодом, который фронтенд переводит на нужный язык. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function body(code: string, message: string): ApiError {
  return { error: { code, message } };
}

/** Проверяет данные схемой zod; при ошибке — 400 VALIDATION с перечнем полей. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
    throw new AppError(400, 'VALIDATION', details);
  }
  return result.data;
}

/** Все ошибки отдаются в одном формате `{ error: { code, message } }`; внутренние детали не раскрываются. */
export function registerErrorHandlers(app: FastifyInstance, options: { spaIndexHtml?: string } = {}): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message));
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.status(status).send(body(err.code ?? 'BAD_REQUEST', err.message));
    }
    request.log.error(err);
    return reply.status(500).send(body('INTERNAL', 'Внутренняя ошибка сервера'));
  });

  app.setNotFoundHandler((request, reply) => {
    // Собранный интерфейс — одностраничное приложение: неизвестные пути вне /api и /ws отдают index.html.
    const isApi = request.url.startsWith('/api') || request.url.startsWith('/ws');
    if (options.spaIndexHtml && request.method === 'GET' && !isApi) {
      return reply.type('text/html; charset=utf-8').send(options.spaIndexHtml);
    }
    reply.status(404).send(body('NOT_FOUND', `Маршрут не найден: ${request.method} ${request.url}`));
  });
}

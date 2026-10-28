// Формы данных, которыми обмениваются backend и frontend.

import type { Role } from './domain';

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
}

/** Единый формат ошибки API: `{ error: { code, message } }`. Текст переводит фронтенд по `code`. */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface HealthResponse {
  status: 'ok';
  time: string;
  db: {
    schemaVersion: number;
    stations: number;
  };
}

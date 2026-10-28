// Панель администратора (ТЗ §5.7, ARCHITECTURE §10–§11). Все маршруты — только роль admin.
// Каждое изменение пишется в audit_log в той же транзакции, что и само изменение (кто, что, было → стало).
//
//   станции:     GET/POST /api/admin/stations · PATCH/DELETE /api/admin/stations/:id (DELETE = отключить)
//                PUT /api/admin/stations/:id/parameters (набор показателей и пороги W < D)
//                POST /api/admin/stations/:id/token (новый токен устройства, показывается один раз)
//   модель:      GET/PUT /api/admin/risk-config (коэффициенты; версия растёт, следующая оценка уже по новым)
//   пользователи: GET/POST /api/admin/users · PATCH/DELETE /api/admin/users/:id
//   наблюдение:  GET /api/admin/sources · /device-log · /audit · POST /api/admin/backup

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_RISK_CONFIG, PARAMETER_CODES, ROLES, STATION_STATUSES, STATION_TYPES, resolveRiskConfig } from '@qorgan/shared';
import { closeStationAlerts } from '../alerts/engine';
import { requireRole } from '../auth/plugin';
import { hashPassword } from '../auth/password';
import { backupDb } from '../db/backup';
import { transaction, type Db } from '../db/connection';
import { AppError, parse } from '../errors';
import { loadRiskConfig } from '../risk/service';
import { activeRun } from '../simulation/repository';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const stationFields = {
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/, 'код: латиница, цифры и дефис, 2–16 символов'),
  name: z.string().trim().min(2).max(64),
  stationType: z.enum(STATION_TYPES),
  status: z.enum(STATION_STATUSES),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  upstreamCode: z.string().trim().max(16).nullable(),
  travelHours: z.number().min(0).max(240).nullable(),
  attenuation: z.number().min(0.1).max(3),
  responseHours: z.number().int().min(1).max(24),
  baseLevelCm: z.number().min(0).max(1500).nullable(),
};
const createStation = z.object(stationFields).partial({ status: true, upstreamCode: true, travelHours: true, attenuation: true, responseHours: true, baseLevelCm: true }).strict();
const updateStation = z.object(stationFields).omit({ code: true }).partial().strict();

const threshold = z.number().min(-50).max(1500).nullable();
const parametersBody = z
  .object({
    parameters: z
      .array(z.object({ code: z.enum(PARAMETER_CODES), warning: threshold.default(null), danger: threshold.default(null) }).strict())
      .min(1)
      .max(PARAMETER_CODES.length),
  })
  .strict();

const positive = (max: number) => z.number().positive().max(max);
const riskConfigBody = z
  .object({
    windowSize: z.number().int().min(3).max(24),
    minPoints: z.number().int().min(2).max(24),
    epsilonCmH: z.number().min(0).max(10),
    maxJumpCm: positive(500),
    maxGapH: positive(48),
    staleAfterH: positive(48),
    accelerationCmH: positive(50),
    forecastHorizonH: positive(24),
    highEtaH: positive(72),
    mediumEtaH: positive(168),
    etaMaxH: positive(240),
    upstreamHorizonH: positive(240),
    rainWindowH: positive(48),
    rainModerateMm: positive(500),
    rainHeavyMm: positive(500),
    meltWindowH: positive(72),
    meltTempC: z.number().min(-20).max(20),
    clearAfterLowCount: z.number().int().min(1).max(24),
    points: z.object(Object.fromEntries(Object.keys(DEFAULT_RISK_CONFIG.points).map((k) => [k, z.number().int().min(0).max(10)]))).partial().strict(),
    categories: z.object({ highScore: z.number().int().min(1).max(20), mediumScore: z.number().int().min(1).max(20) }).partial().strict(),
  })
  .partial()
  .strict();

const password = z.string().min(10, 'пароль не короче 10 символов').max(128);
const createUser = z.object({ username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/), password, role: z.enum(ROLES) }).strict();
const updateUser = z.object({ role: z.enum(ROLES), isActive: z.boolean(), password }).partial().strict();

const logQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface AdminOptions {
  backupDir?: string;
}

export function adminRoutes(db: Db, now: () => Date, onChanged: () => void, options: AdminOptions = {}) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireRole('admin'));
    const uid = (r: FastifyRequest) => r.user?.id ?? null;
    const audit = (r: FastifyRequest, action: string, entity: string, entityId: string | number | null, before: unknown, after: unknown) =>
      db
        .prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uid(r), action, entity, entityId === null ? null : String(entityId), before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now().toISOString());

    // ── Станции ──────────────────────────────────────────────────────────────────────────────────────────────
    const stationRow = (id: number) => {
      const r = db
        .prepare(
          `SELECT s.*, u.code AS upstream_code FROM stations s LEFT JOIN stations u ON u.id = s.upstream_station_id WHERE s.id = ?`,
        )
        .get(id);
      if (!r) return null;
      return {
        id: Number(r.id),
        code: String(r.code),
        name: String(r.name),
        hazardType: String(r.hazard_type),
        stationType: String(r.station_type),
        status: String(r.status),
        lat: Number(r.lat),
        lon: Number(r.lon),
        upstreamCode: r.upstream_code === null ? null : String(r.upstream_code),
        travelHours: r.travel_hours === null ? null : Number(r.travel_hours),
        attenuation: Number(r.attenuation),
        responseHours: Number(r.response_hours),
        baseLevelCm: r.base_level_cm === null ? null : Number(r.base_level_cm),
        hasDeviceToken: r.device_token_hash !== null,
        lastMessageAt: r.last_message_at === null ? null : String(r.last_message_at),
        parameters: db
          .prepare('SELECT parameter_code, warning, danger FROM station_parameters WHERE station_id = ? ORDER BY parameter_code')
          .all(id)
          .map((p) => ({ code: String(p.parameter_code), warning: p.warning === null ? null : Number(p.warning), danger: p.danger === null ? null : Number(p.danger) })),
      };
    };
    const requireStation = (id: number) => {
      const s = stationRow(id);
      if (!s) throw new AppError(404, 'STATION_NOT_FOUND', `Станция не найдена: ${id}`);
      return s;
    };

    /** id станции выше по течению; проверяет, что она существует и цепочка не замыкается в кольцо. */
    const resolveUpstream = (code: string | null | undefined, selfId: number | null): number | null => {
      if (!code) return null;
      const up = db.prepare('SELECT id FROM stations WHERE code = ? COLLATE NOCASE').get(code);
      if (!up) throw new AppError(400, 'UPSTREAM_NOT_FOUND', `Нет станции ${code}`);
      let cursor: number | null = Number(up.id);
      for (let guard = 0; cursor !== null && guard < 1000; guard += 1) {
        if (cursor === selfId) throw new AppError(400, 'UPSTREAM_CYCLE', 'Цепочка станций по течению не может замыкаться');
        const next: Record<string, unknown> | undefined = db.prepare('SELECT upstream_station_id FROM stations WHERE id = ?').get(cursor);
        cursor = next?.upstream_station_id === null || next?.upstream_station_id === undefined ? null : Number(next.upstream_station_id);
      }
      return Number(up.id);
    };

    app.get('/api/admin/stations', async () => ({
      items: db.prepare('SELECT id FROM stations ORDER BY id').all().map((r) => stationRow(Number(r.id))),
    }));

    app.post('/api/admin/stations', async (request, reply) => {
      const input = parse(createStation, request.body);
      if (db.prepare('SELECT 1 FROM stations WHERE code = ? COLLATE NOCASE').get(input.code)) {
        throw new AppError(409, 'STATION_CODE_TAKEN', `Код ${input.code} уже занят`);
      }
      const at = now().toISOString();
      const id = transaction(db, () => {
        const upstreamId = resolveUpstream(input.upstreamCode, null);
        if (upstreamId !== null && (input.travelHours === undefined || input.travelHours === null)) {
          throw new AppError(400, 'TRAVEL_HOURS_REQUIRED', 'Для станции ниже по течению укажите время добегания');
        }
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO stations (code, name, station_type, status, lat, lon, upstream_station_id, travel_hours, attenuation, response_hours, base_level_cm, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.code, input.name, input.stationType, input.status ?? 'active', input.lat, input.lon, upstreamId,
            upstreamId === null ? null : (input.travelHours ?? null), input.attenuation ?? 1, input.responseHours ?? 1, input.baseLevelCm ?? null, at, at,
          );
        const newId = Number(lastInsertRowid);
        // Набор показателей по умолчанию — по типу станции; пороги задаются отдельно.
        const sensors = input.stationType === 'hydro' ? ['water_level'] : input.stationType === 'meteo' ? ['precipitation', 'air_temp'] : [...PARAMETER_CODES];
        const ins = db.prepare('INSERT INTO station_parameters (station_id, parameter_code) VALUES (?, ?)');
        for (const p of sensors) ins.run(newId, p);
        audit(request, 'STATION_CREATE', 'station', newId, null, stationRow(newId));
        return newId;
      });
      onChanged();
      return reply.status(201).send({ station: stationRow(id) });
    });

    app.patch('/api/admin/stations/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      const input = parse(updateStation, request.body);
      const before = requireStation(id);
      transaction(db, () => {
        const sets: string[] = [];
        const values: Array<string | number | null> = [];
        const set = (col: string, v: string | number | null) => {
          sets.push(`${col} = ?`);
          values.push(v);
        };
        if (input.name !== undefined) set('name', input.name);
        if (input.stationType !== undefined) set('station_type', input.stationType);
        if (input.status !== undefined) set('status', input.status);
        if (input.lat !== undefined) set('lat', input.lat);
        if (input.lon !== undefined) set('lon', input.lon);
        if (input.upstreamCode !== undefined) set('upstream_station_id', resolveUpstream(input.upstreamCode, id));
        if (input.travelHours !== undefined) set('travel_hours', input.travelHours);
        if (input.attenuation !== undefined) set('attenuation', input.attenuation);
        if (input.responseHours !== undefined) set('response_hours', input.responseHours);
        if (input.baseLevelCm !== undefined) set('base_level_cm', input.baseLevelCm);
        if (sets.length === 0) return;
        set('updated_at', now().toISOString());
        db.prepare(`UPDATE stations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
        const after = stationRow(id)!;
        if (after.status === 'disabled' && before.status !== 'disabled') closeStationAlerts(db, id, now().toISOString());
        if (after.upstreamCode !== null && after.travelHours === null) {
          throw new AppError(400, 'TRAVEL_HOURS_REQUIRED', 'Для станции ниже по течению укажите время добегания');
        }
        audit(request, 'STATION_UPDATE', 'station', id, before, after);
      });
      onChanged();
      return { station: stationRow(id) };
    });

    // Отключение вместо удаления: история измерений и предупреждений станции сохраняется (INT-005).
    app.delete('/api/admin/stations/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      const before = requireStation(id);
      transaction(db, () => {
        db.prepare("UPDATE stations SET status = 'disabled', updated_at = ? WHERE id = ?").run(now().toISOString(), id);
        closeStationAlerts(db, id, now().toISOString());
        audit(request, 'STATION_DISABLE', 'station', id, { status: before.status }, { status: 'disabled' });
      });
      onChanged();
      return { station: stationRow(id) };
    });

    app.put('/api/admin/stations/:id/parameters', async (request) => {
      const { id } = parse(idParam, request.params);
      const { parameters } = parse(parametersBody, request.body);
      const before = requireStation(id);
      const codes = new Set(parameters.map((p) => p.code));
      if (codes.size !== parameters.length) throw new AppError(400, 'VALIDATION', 'Показатель указан дважды');
      for (const p of parameters) {
        if (p.warning !== null && p.danger !== null && p.warning >= p.danger) {
          throw new AppError(400, 'THRESHOLD_ORDER', `Порог предупреждения должен быть ниже опасного (${p.code})`);
        }
      }
      transaction(db, () => {
        db.prepare('DELETE FROM station_parameters WHERE station_id = ?').run(id);
        const ins = db.prepare('INSERT INTO station_parameters (station_id, parameter_code, warning, danger) VALUES (?, ?, ?, ?)');
        for (const p of parameters) ins.run(id, p.code, p.warning, p.danger);
        db.prepare('UPDATE stations SET updated_at = ? WHERE id = ?').run(now().toISOString(), id);
        audit(request, 'STATION_PARAMETERS', 'station', id, before.parameters, parameters);
      });
      onChanged();
      return { station: stationRow(id) };
    });

    app.post('/api/admin/stations/:id/token', async (request) => {
      const { id } = parse(idParam, request.params);
      const st = requireStation(id);
      const token = `qd_${randomBytes(24).toString('base64url')}`;
      transaction(db, () => {
        db.prepare('UPDATE stations SET device_token_hash = ?, updated_at = ? WHERE id = ?').run(sha256(token), now().toISOString(), id);
        // В аудит — только факт выпуска, не сам токен.
        audit(request, 'STATION_TOKEN', 'station', id, { hadToken: st.hasDeviceToken }, { hasToken: true });
      });
      return { stationCode: st.code, token, note: 'TOKEN_SHOWN_ONCE' };
    });

    // ── Внешние устройства (Python-датчик и др. через MQTT) ──────────────────────────────────────────────────
    const deviceRow = (id: number) => {
      const r = db.prepare('SELECT d.*, s.code AS station_code FROM devices d JOIN stations s ON s.id = d.station_id WHERE d.id = ?').get(id);
      return r
        ? { id: Number(r.id), deviceId: String(r.device_id), name: String(r.name), stationCode: String(r.station_code), status: String(r.status), lastSeenAt: r.last_seen_at === null ? null : String(r.last_seen_at), accepted: Number(r.accepted_count), rejected: Number(r.rejected_count) }
        : null;
    };
    const deviceBody = z.object({
      deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/),
      name: z.string().trim().min(2).max(64),
      stationCode: z.string().trim().min(1).max(32),
    }).strict();
    const stationIdByCode = (code: string) => {
      const st = db.prepare("SELECT id FROM stations WHERE code = ? COLLATE NOCASE AND status <> 'disabled'").get(code);
      if (!st) throw new AppError(400, 'STATION_NOT_FOUND', `Нет активной станции ${code}`);
      return Number(st.id);
    };

    app.get('/api/admin/devices', async () => ({
      items: db.prepare('SELECT id FROM devices ORDER BY id').all().map((r) => deviceRow(Number(r.id))),
    }));

    app.post('/api/admin/devices', async (request, reply) => {
      const input = parse(deviceBody, request.body);
      if (db.prepare('SELECT 1 FROM devices WHERE device_id = ?').get(input.deviceId)) throw new AppError(409, 'DEVICE_ID_TAKEN', 'Такой идентификатор устройства уже есть');
      const token = `qs_${randomBytes(24).toString('base64url')}`;
      const at = now().toISOString();
      const id = transaction(db, () => {
        const { lastInsertRowid } = db
          .prepare('INSERT INTO devices (device_id, name, station_id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(input.deviceId, input.name, stationIdByCode(input.stationCode), sha256(token), at, at);
        audit(request, 'DEVICE_CREATE', 'device', Number(lastInsertRowid), null, deviceRow(Number(lastInsertRowid)));
        return Number(lastInsertRowid);
      });
      onChanged();
      return reply.status(201).send({ device: deviceRow(id), token, note: 'TOKEN_SHOWN_ONCE' });
    });

    app.patch('/api/admin/devices/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      const input = parse(z.object({ name: z.string().trim().min(2).max(64), stationCode: z.string().trim().min(1).max(32), status: z.enum(['active', 'disabled']) }).partial().strict(), request.body);
      const before = deviceRow(id);
      if (!before) throw new AppError(404, 'DEVICE_NOT_FOUND', `Устройство не найдено: ${id}`);
      transaction(db, () => {
        const at = now().toISOString();
        if (input.name !== undefined) db.prepare('UPDATE devices SET name = ?, updated_at = ? WHERE id = ?').run(input.name, at, id);
        if (input.stationCode !== undefined) db.prepare('UPDATE devices SET station_id = ?, updated_at = ? WHERE id = ?').run(stationIdByCode(input.stationCode), at, id);
        if (input.status !== undefined) db.prepare('UPDATE devices SET status = ?, updated_at = ? WHERE id = ?').run(input.status, at, id);
        audit(request, 'DEVICE_UPDATE', 'device', id, before, deviceRow(id));
      });
      onChanged();
      return { device: deviceRow(id) };
    });

    app.post('/api/admin/devices/:id/token', async (request) => {
      const { id } = parse(idParam, request.params);
      const dev = deviceRow(id);
      if (!dev) throw new AppError(404, 'DEVICE_NOT_FOUND', `Устройство не найдено: ${id}`);
      const token = `qs_${randomBytes(24).toString('base64url')}`;
      transaction(db, () => {
        db.prepare('UPDATE devices SET token_hash = ?, updated_at = ? WHERE id = ?').run(sha256(token), now().toISOString(), id);
        audit(request, 'DEVICE_TOKEN', 'device', id, null, { reissued: true });
      });
      return { deviceId: dev.deviceId, token, note: 'TOKEN_SHOWN_ONCE' };
    });

    // ── Коэффициенты модели риска ────────────────────────────────────────────────────────────────────────────
    app.get('/api/admin/risk-config', async () => {
      const row = db.prepare('SELECT version, updated_at, updated_by FROM risk_config WHERE id = 1').get();
      return {
        config: loadRiskConfig(db).config,
        defaults: DEFAULT_RISK_CONFIG,
        version: row ? Number(row.version) : null,
        updatedAt: row ? String(row.updated_at) : null,
      };
    });

    app.put('/api/admin/risk-config', async (request) => {
      const patch = parse(riskConfigBody, request.body);
      const current = loadRiskConfig(db);
      const merged = resolveRiskConfig({
        ...current.config,
        ...patch,
        points: { ...current.config.points, ...(patch.points ?? {}) },
        categories: { ...current.config.categories, ...(patch.categories ?? {}) },
      });
      const problems: string[] = [];
      if (merged.minPoints > merged.windowSize) problems.push('minPoints ≤ windowSize');
      if (merged.categories.mediumScore >= merged.categories.highScore) problems.push('categories.mediumScore < categories.highScore');
      if (merged.rainModerateMm >= merged.rainHeavyMm) problems.push('rainModerateMm < rainHeavyMm');
      if (merged.highEtaH > merged.mediumEtaH) problems.push('highEtaH ≤ mediumEtaH');
      if (problems.length) throw new AppError(400, 'RISK_CONFIG_INCONSISTENT', problems.join('; '));
      const version = transaction(db, () => {
        const next = (current.version ?? 0) + 1;
        db.prepare(
          `INSERT INTO risk_config (id, json, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).run(JSON.stringify(merged), next, now().toISOString(), uid(request));
        audit(request, 'RISK_CONFIG_UPDATE', 'risk_config', 1, { version: current.version, config: current.config }, { version: next, config: merged });
        return next;
      });
      onChanged();
      return { config: merged, version };
    });

    // ── Пользователи ─────────────────────────────────────────────────────────────────────────────────────────
    const userRow = (id: number) => {
      const r = db.prepare('SELECT id, username, role, is_active, created_at, updated_at FROM users WHERE id = ?').get(id);
      return r
        ? { id: Number(r.id), username: String(r.username), role: String(r.role), isActive: Number(r.is_active) === 1, createdAt: String(r.created_at), updatedAt: String(r.updated_at) }
        : null;
    };
    const activeAdmins = () => Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get()?.n ?? 0);

    app.get('/api/admin/users', async () => ({
      items: db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => userRow(Number(r.id))),
    }));

    app.post('/api/admin/users', async (request, reply) => {
      const input = parse(createUser, request.body);
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username)) throw new AppError(409, 'USERNAME_TAKEN', 'Логин уже занят');
      const at = now().toISOString();
      const id = transaction(db, () => {
        const { lastInsertRowid } = db
          .prepare('INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(input.username, hashPassword(input.password), input.role, at, at);
        const newId = Number(lastInsertRowid);
        audit(request, 'USER_CREATE', 'user', newId, null, userRow(newId));
        return newId;
      });
      return reply.status(201).send({ user: userRow(id) });
    });

    app.patch('/api/admin/users/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      const input = parse(updateUser, request.body);
      const before = userRow(id);
      if (!before) throw new AppError(404, 'USER_NOT_FOUND', `Пользователь не найден: ${id}`);
      const losesAdmin = before.role === 'admin' && before.isActive && (input.role === 'operator' || input.isActive === false);
      if (losesAdmin && activeAdmins() <= 1) throw new AppError(409, 'LAST_ADMIN', 'Нельзя понизить или отключить последнего администратора');
      if (id === uid(request) && input.isActive === false) throw new AppError(409, 'SELF_DISABLE', 'Нельзя отключить собственную учётную запись');
      transaction(db, () => {
        const at = now().toISOString();
        if (input.role !== undefined) db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(input.role, at, id);
        if (input.isActive !== undefined) db.prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, at, id);
        if (input.password !== undefined) db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(input.password), at, id);
        // Смена роли, отключение или пароля закрывает действующие сессии пользователя.
        if (input.role !== undefined || input.isActive === false || input.password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        audit(request, 'USER_UPDATE', 'user', id, before, { ...userRow(id), passwordChanged: input.password !== undefined });
      });
      return { user: userRow(id) };
    });

    app.delete('/api/admin/users/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      const before = userRow(id);
      if (!before) throw new AppError(404, 'USER_NOT_FOUND', `Пользователь не найден: ${id}`);
      if (id === uid(request)) throw new AppError(409, 'SELF_DELETE', 'Нельзя удалить собственную учётную запись');
      if (before.role === 'admin' && before.isActive && activeAdmins() <= 1) throw new AppError(409, 'LAST_ADMIN', 'Нельзя удалить последнего администратора');
      // Пользователь с историей действий не удаляется физически — журналы должны оставаться полными.
      const refs = ['audit_log', 'alert_events', 'sim_runs', 'sim_interventions', 'risk_config']
        .map((t) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'sim_runs' ? 'created_by' : t === 'risk_config' ? 'updated_by' : 'user_id'} = ?`).get(id)?.n ?? 0))
        .reduce((a, b) => a + b, 0);
      if (refs > 0) throw new AppError(409, 'USER_HAS_HISTORY', 'У пользователя есть история действий — отключите учётную запись вместо удаления');
      transaction(db, () => {
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        audit(request, 'USER_DELETE', 'user', id, before, null);
      });
      return { deleted: id };
    });

    // ── Источники данных, журналы, резервная копия ───────────────────────────────────────────────────────────
    app.get('/api/admin/sources', async () => {
      const run = activeRun(db);
      const tickMs = run?.tickMs ?? null;
      const at = now().getTime();
      const since = new Date(at - 24 * 3_600_000).toISOString();
      const rows = db.prepare('SELECT id, code, name, status, last_message_at, device_token_hash FROM stations ORDER BY id').all();
      const rejected = db.prepare('SELECT COUNT(*) AS n FROM device_log WHERE station_id = ? AND created_at > ?');
      const suspect = run ? db.prepare("SELECT COUNT(*) AS n FROM measurements WHERE run_id = ? AND station_id = ? AND quality <> 'ok'") : null;
      return {
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        tickMs,
        items: rows.map((r) => {
          const last = r.last_message_at === null ? null : Date.parse(String(r.last_message_at));
          // ARCHITECTURE §7: ONLINE ≤ 3 тиков, STALE ≤ 10 тиков, иначе OFFLINE. Без идущего прогона связь не ожидается.
          let link: 'ONLINE' | 'STALE' | 'OFFLINE' | 'IDLE' | 'DISABLED';
          if (r.status === 'disabled') link = 'DISABLED';
          else if (!run || run.status !== 'RUNNING' || tickMs === null) link = 'IDLE';
          else if (last === null) link = 'OFFLINE';
          else link = at - last <= 3 * tickMs ? 'ONLINE' : at - last <= 10 * tickMs ? 'STALE' : 'OFFLINE';
          return {
            id: Number(r.id),
            code: String(r.code),
            name: String(r.name),
            status: String(r.status),
            link,
            lastMessageAt: last === null ? null : String(r.last_message_at),
            rejected24h: Number(rejected.get(Number(r.id), since)?.n ?? 0),
            flaggedInRun: suspect && run ? Number(suspect.get(run.id, Number(r.id))?.n ?? 0) : 0,
            hasDeviceToken: r.device_token_hash !== null,
          };
        }),
      };
    });

    app.get('/api/admin/device-log', async (request) => {
      const { limit } = parse(logQuery, request.query);
      return {
        items: db
          .prepare('SELECT d.id, d.level, d.code, d.details_json, d.created_at, s.code AS station_code FROM device_log d LEFT JOIN stations s ON s.id = d.station_id ORDER BY d.id DESC LIMIT ?')
          .all(limit)
          .map((r) => ({
            id: Number(r.id),
            level: String(r.level),
            code: String(r.code),
            stationCode: r.station_code === null ? null : String(r.station_code),
            details: JSON.parse(String(r.details_json)) as unknown,
            createdAt: String(r.created_at),
          })),
      };
    });

    app.get('/api/admin/audit', async (request) => {
      const { limit } = parse(logQuery, request.query);
      return {
        items: db
          .prepare('SELECT a.id, a.action, a.entity, a.entity_id, a.before_json, a.after_json, a.created_at, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?')
          .all(limit)
          .map((r) => ({
            id: Number(r.id),
            action: String(r.action),
            entity: String(r.entity),
            entityId: r.entity_id === null ? null : String(r.entity_id),
            user: r.username === null ? null : String(r.username),
            before: r.before_json === null ? null : (JSON.parse(String(r.before_json)) as unknown),
            after: r.after_json === null ? null : (JSON.parse(String(r.after_json)) as unknown),
            createdAt: String(r.created_at),
          })),
      };
    });

    app.post('/api/admin/backup', async (request) => {
      if (!options.backupDir) throw new AppError(503, 'BACKUP_UNAVAILABLE', 'Папка резервных копий не настроена');
      const file = backupDb(db, options.backupDir, now());
      audit(request, 'BACKUP', 'database', null, null, { file: file.split(/[\\/]/).pop() });
      // Путь на сервере наружу не отдаём — только имя файла.
      return { file: file.split(/[\\/]/).pop() };
    });
  };
}

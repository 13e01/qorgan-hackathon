// Приём пакета телеметрии (docs/ARCHITECTURE.md §7). Всё в одной транзакции:
// проверка → запись измерений → часы прогона → оценка риска всех станций (T2) → сохранение оценок.
// Если что-то падает, не сохраняется ничего, и отправитель может повторить пакет: дубли не создаются.

import { PARAMETERS, type ParameterCode } from '@qorgan/shared';
import { processAlerts, type AlertChange } from '../alerts/engine';
import { transaction, type Db } from '../db/connection';
import { AppError } from '../errors';
import { persistMlAssessments, type MlRuntime } from '../ml/service';
import { createEvaluator, loadRiskConfig, type StationEvaluation } from '../risk/service';
import { externalTickAt, getRun, isExternalRun, updateRun, virtualTime, type RunInfo } from '../simulation/repository';

/** Предел часов модели в одном прогоне внешних датчиков (защита от переполнения БД: ≈ 11 ч при 2 с на час). */
export const EXTERNAL_MAX_TICKS = 20_000;

export interface TelemetryRecord {
  stationCode: string;
  parameter: string;
  value: number;
  unit: string;
  measuredAt: string;
  source?: 'simulator' | 'manual';
}

export interface IngestRequest {
  runId?: number;
  tick?: number;
  records: TelemetryRecord[];
}

/** Кто прислал пакет: встроенный симулятор (через тот же HTTP-маршрут) или устройство конкретной станции. */
export type Sender = { kind: 'simulator' } | { kind: 'device'; stationId: number; stationCode: string };

export type RejectCode =
  | 'UNKNOWN_STATION'
  | 'STATION_DISABLED'
  | 'STATION_MISMATCH'
  | 'UNKNOWN_PARAM'
  | 'REJECTED_UNIT'
  | 'REJECTED_RANGE'
  | 'REJECTED_TIME';

/**
 * Дополнения QORGAN Sentinel, выполняются в той же транзакции: параллельная оценка ML (после оценок T2)
 * и постановка Telegram-уведомлений в очередь (после предупреждений). Ни то ни другое не меняет риск T2 и
 * предупреждения; их ошибки не откатывают пакет.
 */
export interface IngestExtensions {
  ml?: MlRuntime;
  afterAlerts?: (ctx: { runId: number; tick: number; changes: AlertChange[]; evaluations: StationEvaluation[]; now: string }) => void;
  onExtensionError?: (where: 'ml' | 'notify', err: unknown) => void;
}

export interface IngestResult {
  runId: number;
  tick: number;
  virtualTime: string;
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; code: RejectCode }>;
  evaluations: StationEvaluation[];
  /** Изменения предупреждений этого тика (открыты, обострены, сняты). */
  alerts: AlertChange[];
}

const PARAMS = new Map(PARAMETERS.map((p) => [p.code as string, p]));

function persistAssessments(db: Db, runId: number, tick: number, evaluations: StationEvaluation[], configVersion: number | null): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO risk_assessments
       (run_id, station_id, tick, measured_at, risk, score, level_cm, rate_cm_h, trend, forecast_3h_cm, forecast_3h_low,
        forecast_3h_high, eta_danger_h, eta_low_h, eta_high_h, confidence, factors_json, config_version, thresholds_json, assessment_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { station, assessment: a } of evaluations) {
    stmt.run(
      runId, station.id, tick, a.asOf, a.risk, a.score, a.level.currentCm, a.trend.rateCmH, a.trend.direction,
      a.forecast.levelCm, a.forecast.lowCm, a.forecast.highCm, a.eta.hours, a.eta.lowH, a.eta.highH,
      a.dataQuality.confidence, JSON.stringify(a.factors), configVersion ?? 0,
      JSON.stringify({ warningCm: a.level.warningCm, dangerCm: a.level.dangerCm }), JSON.stringify(a),
    );
  }
}

function resolveRun(db: Db, sender: Sender, req: IngestRequest, now: string): { run: RunInfo; tick: number } {
  if (sender.kind === 'simulator') {
    if (req.runId === undefined || req.tick === undefined) throw new AppError(400, 'VALIDATION', 'runId и tick обязательны для симулятора');
    const run = getRun(db, req.runId);
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `Прогон не найден: ${req.runId}`);
    if (run.status !== 'RUNNING' && run.status !== 'PAUSED') {
      throw new AppError(409, 'RUN_NOT_ACTIVE', `Прогон ${run.id} в состоянии ${run.status} — приём данных закрыт`);
    }
    const expected = (run.currentTick ?? -1) + 1;
    if (req.tick > expected) throw new AppError(409, 'TICK_OUT_OF_ORDER', `Ожидался тик ≤ ${expected}, получен ${req.tick}`);
    if (run.totalTicks !== null && req.tick >= run.totalTicks) throw new AppError(409, 'TICK_OUT_OF_RANGE', 'Тик за пределами сценария');
    return { run, tick: req.tick };
  }
  const control = db.prepare('SELECT run_id FROM sim_control WHERE id = 1').get();
  const run = control?.run_id === null || control?.run_id === undefined ? null : getRun(db, Number(control.run_id));
  if (!run || (run.status !== 'RUNNING' && run.status !== 'PAUSED')) {
    throw new AppError(409, 'NO_ACTIVE_RUN', 'Нет активного прогона, к которому можно привязать измерения');
  }
  if (req.runId !== undefined && req.runId !== run.id) throw new AppError(409, 'RUN_MISMATCH', 'runId не совпадает с активным прогоном');
  if (isExternalRun(run)) {
    // Режим внешних датчиков: часы прогона двигают сами показания. Час модели вычисляет MQTT-адаптер по реальному
    // времени показания; показание из будущего (дальше следующего часа по реальным часам сервера) не принимается.
    if (req.tick === undefined) throw new AppError(400, 'VALIDATION', 'tick обязателен в режиме внешних датчиков');
    if (req.tick > externalTickAt(run, Date.parse(now)) + 1) throw new AppError(409, 'TICK_IN_FUTURE', 'Показание из будущего');
    if (req.tick > EXTERNAL_MAX_TICKS) throw new AppError(409, 'RUN_FULL', 'Прогон внешних датчиков слишком длинный — начните новый');
    return { run, tick: req.tick };
  }
  if (run.currentTick === null) throw new AppError(409, 'RUN_NOT_STARTED', 'Виртуальные часы прогона ещё не запущены');
  return { run, tick: run.currentTick };
}

export function ingest(db: Db, sender: Sender, req: IngestRequest, now: string, extensions: IngestExtensions = {}): IngestResult {
  return transaction(db, () => {
    const { run, tick } = resolveRun(db, sender, req, now);
    const external = isExternalRun(run);
    const tickTime = virtualTime(run, tick);
    const rejected: IngestResult['rejected'] = [];
    let accepted = 0;
    let duplicates = 0;
    const touched = new Set<number>();

    const stationByCode = db.prepare('SELECT id, status FROM stations WHERE code = ?');
    const hasSensor = db.prepare('SELECT 1 FROM station_parameters WHERE station_id = ? AND parameter_code = ?');
    const previous = db.prepare(
      `SELECT value, measured_at FROM measurements WHERE run_id = ? AND station_id = ? AND parameter_code = ?
       ORDER BY measured_at DESC LIMIT 1`,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO measurements
         (run_id, station_id, parameter_code, value, unit, measured_at, received_at, tick, source, quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const log = db.prepare("INSERT INTO device_log (station_id, level, code, details_json, created_at) VALUES (?, 'warn', ?, ?, ?)");

    req.records.forEach((r, index) => {
      const reject = (code: RejectCode, stationId: number | null) => {
        rejected.push({ index, code });
        log.run(stationId, code, JSON.stringify({ runId: run.id, tick, index, stationCode: r.stationCode, parameter: r.parameter, value: r.value, unit: r.unit, measuredAt: r.measuredAt }), now);
      };
      const station = stationByCode.get(r.stationCode);
      if (!station) return reject('UNKNOWN_STATION', null);
      const stationId = Number(station.id);
      if (sender.kind === 'device' && r.stationCode !== sender.stationCode) return reject('STATION_MISMATCH', sender.stationId);
      if (station.status === 'disabled') return reject('STATION_DISABLED', stationId);
      const def = PARAMS.get(r.parameter);
      if (!def || !hasSensor.get(stationId, r.parameter)) return reject('UNKNOWN_PARAM', stationId);
      if (r.unit !== def.unit) return reject('REJECTED_UNIT', stationId);
      if (!Number.isFinite(r.value) || r.value < def.minValid || r.value > def.maxValid) return reject('REJECTED_RANGE', stationId);

      const measuredMs = Date.parse(r.measuredAt);
      if (!Number.isFinite(measuredMs)) return reject('REJECTED_TIME', stationId);
      const measuredAt = new Date(measuredMs).toISOString();
      // Симулятор обязан ставить точное виртуальное время тика; устройство — не позже часов прогона.
      // Симулятор и внешний датчик (через MQTT-адаптер) ставят точное время своего часа; устройство по HTTP — не позже часов прогона.
      if (sender.kind === 'simulator' || external ? measuredAt !== tickTime : measuredAt > tickTime || measuredAt < run.simStart) {
        return reject('REJECTED_TIME', stationId);
      }

      const prev = previous.get(run.id, stationId, r.parameter);
      let quality: 'ok' | 'late' | 'suspect' = 'ok';
      if (prev && measuredAt < String(prev.measured_at)) quality = 'late';
      else if (prev && def.maxStep !== null) {
        const hours = Math.max(1, (measuredMs - Date.parse(String(prev.measured_at))) / 3_600_000);
        if (Math.abs(r.value - Number(prev.value)) > def.maxStep * hours) quality = 'suspect';
      }
      const source = sender.kind === 'device' ? 'device' : (r.source ?? 'simulator');
      const { changes } = insert.run(run.id, stationId, r.parameter as ParameterCode, r.value, r.unit, measuredAt, now, tick, source, quality);
      if (Number(changes) === 0) duplicates += 1;
      else {
        accepted += 1;
        touched.add(stationId);
      }
    });

    if ((sender.kind === 'simulator' || external) && (run.currentTick === null || tick > run.currentTick)) updateRun(db, run.id, { currentTick: tick });
    const touch = db.prepare('UPDATE stations SET last_message_at = ? WHERE id = ?');
    for (const id of touched) touch.run(now, id);

    // Оценка на виртуальное время этого тика: при повторной отправке старого тика будущие данные не используются.
    const evaluator = createEvaluator(db, { runId: run.id, at: tickTime, computedAt: now });
    const evaluations = evaluator.evaluateAll();
    persistAssessments(db, run.id, tick, evaluations, evaluator.configVersion);
    if (extensions.ml) {
      try {
        persistMlAssessments(db, extensions.ml, run.id, tick, tickTime, evaluations, now);
      } catch (err) {
        extensions.onExtensionError?.('ml', err);
      }
    }
    // Предупреждения — в той же транзакции, что и оценки, которые их вызвали (ТЗ §5.6).
    // Повторная отправка старого тика (tick < часов прогона) не меняет предупреждения: иначе снятое могло бы «ожить».
    const replay = run.currentTick !== null && tick < run.currentTick;
    const alerts = replay ? [] : processAlerts(db, run.id, tick, evaluations, now, loadRiskConfig(db).config.clearAfterLowCount);
    if (alerts.length > 0 && extensions.afterAlerts) {
      try {
        extensions.afterAlerts({ runId: run.id, tick, changes: alerts, evaluations, now });
      } catch (err) {
        extensions.onExtensionError?.('notify', err);
      }
    }

    return { runId: run.id, tick, virtualTime: tickTime, accepted, duplicates, rejected, evaluations, alerts };
  });
}

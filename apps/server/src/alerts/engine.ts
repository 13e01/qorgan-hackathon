// Автоматические предупреждения (docs/ARCHITECTURE.md §9, ТЗ §5.6). Вызывается в той же транзакции, что и запись
// пакета телеметрии и оценок риска: предупреждение не может «потеряться» или появиться без оценки, которая его вызвала.
//
//   риск MEDIUM/HIGH и активного предупреждения нет  → OPENED (время, станция, тип ЧС, уровень, причина, факторы)
//   MEDIUM → HIGH                                    → ESCALATED (если уже обработано — снова NEW: нужна новая реакция)
//   HIGH → MEDIUM                                    → DEESCALATED
//   риск LOW clearAfterLowCount оценок подряд          → CLEARED (условие снято, is_active = 0)
//   прогон остановлен / завершён / сброшен            → CLEARED с комментарием RUN_ENDED
// Дубли исключены уникальным индексом one_active_alert (одно активное предупреждение на станцию в прогоне).

import type { Reason, RiskLevel } from '@qorgan/shared';
import { transaction, type Db } from '../db/connection';
import type { StationEvaluation } from '../risk/service';

export type AlertSeverity = 'MEDIUM' | 'HIGH';
export type AlertTrigger = 'DANGER_LEVEL' | 'FORECAST';
export type AlertStatus = 'NEW' | 'VIEWED' | 'RESOLVED';
export type AlertEventType = 'OPENED' | 'ESCALATED' | 'DEESCALATED' | 'CLEARED' | 'VIEWED' | 'RESOLVED';

export interface AlertChange {
  alertId: number;
  stationCode: string;
  type: AlertEventType;
  severity: AlertSeverity;
}

const MAX_REASONS = 5;

function triggerOf(e: StationEvaluation): AlertTrigger {
  const { currentCm, dangerCm } = e.assessment.level;
  return currentCm !== null && dangerCm !== null && currentCm >= dangerCm ? 'DANGER_LEVEL' : 'FORECAST';
}

function reasonsOf(e: StationEvaluation): Reason[] {
  return e.assessment.reasons.slice(0, MAX_REASONS);
}

/** Сколько последних сохранённых оценок станции подряд имеют риск LOW (не больше `limit`). */
function recentLowCount(db: Db, runId: number, stationId: number, tick: number, limit: number): number {
  const rows = db
    .prepare('SELECT risk FROM risk_assessments WHERE run_id = ? AND station_id = ? AND tick <= ? ORDER BY tick DESC LIMIT ?')
    .all(runId, stationId, tick, limit);
  let n = 0;
  for (const r of rows) {
    if (r.risk !== 'LOW') break;
    n += 1;
  }
  return n;
}

/**
 * Обновляет предупреждения по оценкам одного тика. Должна вызываться внутри транзакции приёма пакета,
 * после сохранения оценок в risk_assessments. Возвращает изменения (для уведомления интерфейса).
 */
export function processAlerts(
  db: Db,
  runId: number,
  tick: number,
  evaluations: StationEvaluation[],
  now: string,
  clearAfterLowCount: number,
): AlertChange[] {
  const changes: AlertChange[] = [];
  const findActive = db.prepare(
    'SELECT id, severity, trigger, status, last_tick FROM alerts WHERE run_id = ? AND station_id = ? AND is_active = 1',
  );
  const hazard = db.prepare('SELECT hazard_type FROM stations WHERE id = ?');
  const insertAlert = db.prepare(
    `INSERT INTO alerts (run_id, station_id, hazard_type, severity, trigger, status, is_active, opened_tick, last_tick, reasons_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'NEW', 1, ?, ?, ?, ?, ?)`,
  );
  const event = db.prepare('INSERT INTO alert_events (alert_id, tick, type, user_id, comment, created_at) VALUES (?, ?, ?, NULL, ?, ?)');

  for (const e of evaluations) {
    const risk: RiskLevel = e.assessment.risk;
    const active = findActive.get(runId, e.station.id);
    // Повторная отправка старого тика не должна откатывать более свежее состояние предупреждения.
    if (active && Number(active.last_tick) > tick) continue;

    if (risk === 'MEDIUM' || risk === 'HIGH') {
      const trigger = triggerOf(e);
      const reasons = JSON.stringify(reasonsOf(e));
      if (!active) {
        const hazardType = String(hazard.get(e.station.id)?.hazard_type ?? 'flood');
        const { lastInsertRowid } = insertAlert.run(runId, e.station.id, hazardType, risk, trigger, tick, tick, reasons, now, now);
        const alertId = Number(lastInsertRowid);
        event.run(alertId, tick, 'OPENED', null, now);
        changes.push({ alertId, stationCode: e.station.code, type: 'OPENED', severity: risk });
        continue;
      }
      const alertId = Number(active.id);
      const prev = active.severity as AlertSeverity;
      if (prev !== risk) {
        const type: AlertEventType = risk === 'HIGH' ? 'ESCALATED' : 'DEESCALATED';
        // Обострение требует новой реакции оператора: обработанное предупреждение снова становится NEW.
        const status = type === 'ESCALATED' ? 'NEW' : String(active.status);
        db.prepare('UPDATE alerts SET severity = ?, trigger = ?, status = ?, last_tick = ?, reasons_json = ?, updated_at = ? WHERE id = ?').run(
          risk, trigger, status, tick, reasons, now, alertId,
        );
        event.run(alertId, tick, type, null, now);
        changes.push({ alertId, stationCode: e.station.code, type, severity: risk });
      } else {
        // Причина «опасный уровень» сильнее «ухудшения прогноза»: пока уровень выше порога, она не понижается.
        const nextTrigger = active.trigger === 'DANGER_LEVEL' && trigger === 'FORECAST' && risk === 'HIGH' ? 'DANGER_LEVEL' : trigger;
        db.prepare('UPDATE alerts SET trigger = ?, last_tick = ?, reasons_json = ?, updated_at = ? WHERE id = ?').run(nextTrigger, tick, reasons, now, alertId);
      }
      continue;
    }

    if (active && recentLowCount(db, runId, e.station.id, tick, clearAfterLowCount) >= clearAfterLowCount) {
      const alertId = Number(active.id);
      db.prepare('UPDATE alerts SET is_active = 0, cleared_tick = ?, last_tick = ?, updated_at = ? WHERE id = ?').run(tick, tick, now, alertId);
      event.run(alertId, tick, 'CLEARED', null, now);
      changes.push({ alertId, stationCode: e.station.code, type: 'CLEARED', severity: active.severity as AlertSeverity });
    }
  }
  return changes;
}

/** Прогон закончился (остановлен, завершён, сброшен): его активные предупреждения закрываются, история сохраняется. */
export function closeRunAlerts(db: Db, runId: number, now: string): number {
  return transaction(db, () => {
    const rows = db.prepare('SELECT id, last_tick FROM alerts WHERE run_id = ? AND is_active = 1').all(runId);
    const update = db.prepare('UPDATE alerts SET is_active = 0, cleared_tick = last_tick, updated_at = ? WHERE id = ?');
    const event = db.prepare("INSERT INTO alert_events (alert_id, tick, type, user_id, comment, created_at) VALUES (?, ?, 'CLEARED', NULL, 'RUN_ENDED', ?)");
    for (const r of rows) {
      update.run(now, Number(r.id));
      event.run(Number(r.id), Number(r.last_tick), now);
    }
    return rows.length;
  });
}

// Снимок состояния для интерфейса: состояние симулятора + по каждой станции последние показания и риск.
// Всё берётся на один момент — виртуальное время активного (или последнего) прогона.

import { describeSituation, type RiskSituation } from '@qorgan/shared';
import { alertSummary, type AlertRow } from '../alerts/repository';
import type { Db } from '../db/connection';
import { deviceSummaries, type DeviceSummary } from '../mqtt/devices';
import type { MqttLinkState } from '../mqtt/subscriber';
import { createEvaluator, type EvaluationContext } from '../risk/service';
import type { SimulationRunner, SimulationState } from '../simulation/runner';

export interface StationSnapshot {
  id: number;
  code: string;
  name: string;
  status: string;
  lastMessageAt: string | null;
  latest: Record<string, { value: number; unit: string; measuredAt: string; source: string; quality: string }>;
  risk: {
    risk: string;
    score: number;
    maxScore: number;
    levelCm: number | null;
    /** Время последнего использованного измерения уровня (виртуальное) и его возраст относительно часов прогона. */
    measuredAt: string | null;
    ageH: number | null;
    warningCm: number | null;
    dangerCm: number | null;
    trend: string;
    rateCmH: number | null;
    dataStatus: string;
    confidence: string;
    topReasons: unknown[];
    /** Локальная обстановка отдельно от угрозы сверху по течению (см. describeSituation). */
    situation: RiskSituation;
  };
}

export interface Snapshot {
  simulation: SimulationState;
  context: EvaluationContext;
  stations: StationSnapshot[];
  /** Активные (опубликованные) предупреждения текущего прогона и число необработанных. */
  alerts: { runId: number | null; active: AlertRow[]; unhandled: number };
  /** Внешние датчики (без токенов) и состояние связи QORGAN с MQTT-брокером. */
  devices: DeviceSummary[];
  mqtt: MqttLinkState;
}

export function buildSnapshot(db: Db, runner: SimulationRunner, now: string, mqtt: MqttLinkState = 'disabled'): Snapshot {
  const simulation = runner.state();
  const evaluator = createEvaluator(db, { computedAt: now });
  const latest = db.prepare(
    `SELECT parameter_code, value, unit, measured_at, source, quality FROM measurements m
     WHERE run_id = ? AND station_id = ? AND measured_at <= ?
       AND measured_at = (SELECT MAX(measured_at) FROM measurements
                          WHERE run_id = m.run_id AND station_id = m.station_id AND parameter_code = m.parameter_code AND measured_at <= ?)`,
  );
  const lastMessage = db.prepare('SELECT last_message_at FROM stations WHERE id = ?');
  const stations = evaluator.evaluateAll().map(({ station, assessment: a }) => {
    const readings: StationSnapshot['latest'] = {};
    if (evaluator.runId !== null) {
      for (const r of latest.all(evaluator.runId, station.id, evaluator.asOf, evaluator.asOf)) {
        readings[String(r.parameter_code)] = {
          value: Number(r.value),
          unit: String(r.unit),
          measuredAt: String(r.measured_at),
          source: String(r.source),
          quality: String(r.quality),
        };
      }
    }
    const msg = lastMessage.get(station.id)?.last_message_at;
    return {
      id: station.id,
      code: station.code,
      name: station.name,
      status: station.status,
      lastMessageAt: msg ? String(msg) : null,
      latest: readings,
      risk: {
        risk: a.risk,
        score: a.score,
        maxScore: a.maxScore,
        levelCm: a.level.currentCm,
        measuredAt: a.level.measuredAt,
        ageH: a.level.ageH,
        warningCm: a.level.warningCm,
        dangerCm: a.level.dangerCm,
        trend: a.trend.direction,
        rateCmH: a.trend.rateCmH,
        dataStatus: a.dataQuality.status,
        confidence: a.dataQuality.confidence,
        topReasons: a.reasons.slice(0, 3),
        situation: describeSituation(a),
      },
    };
  });
  return { simulation, context: evaluator.context(), stations, alerts: alertSummary(db), devices: deviceSummaries(db, new Date(now)), mqtt };
}

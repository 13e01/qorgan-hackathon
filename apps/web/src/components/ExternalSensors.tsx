// Внешние датчики (Python-датчик через MQTT): связь, последнее показание, источник данных, текущая оценка станции.
// Всё — из снимка WebSocket (сервер), интерфейс ничего не вычисляет.

import { api } from '../api/client';
import type { DeviceSummary } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';
import { dateTime, metersFromCm, timeWithSeconds } from '../lib/format';
import { useStore } from '../state/store';
import { Icon, RiskBadge } from './ui';

/** Реальных мс в одном часе модели для режима датчиков (= интервал Python-датчика по умолчанию). */
const HOUR_MS = 2000;

function DeviceRow({ d }: { d: DeviceSummary }) {
  const { t, lang } = useI18n();
  const { live, select } = useStore();
  const st = live.snapshot?.stations.find((s) => s.code === d.stationCode);
  return (
    <div className={`device-row link-${d.link}`}>
      <div className="device-main">
        <span className={`chip link-${d.link === 'ONLINE' ? 'ONLINE' : d.link === 'STALE' ? 'STALE' : 'OFFLINE'}`}>{t(`ext.link.${d.link}` as MessageKey)}</span>
        <div className="device-id">
          <b>{d.name}</b>
          <span className="faint num">
            {d.deviceId} · <span className="source-tag">PYTHON SENSOR</span> · MQTT
          </span>
        </div>
        <button className="link-btn device-station" onClick={() => select(d.stationCode)}>
          {d.stationName}
        </button>
      </div>
      <dl className="device-facts">
        <div>
          <dt>{t('ext.last')}</dt>
          <dd className="num">
            <b>{d.lastValue === null ? '—' : `${metersFromCm(d.lastValue, lang)} ${t('unit.m')}`}</b>
            {d.lastValue !== null && <span className="faint"> ({Math.round(d.lastValue * 10) / 10} {t('unit.cm')})</span>}
          </dd>
        </div>
        <div>
          <dt>{t('ext.measuredAt')}</dt>
          <dd className="num">{timeWithSeconds(d.lastSensorAt, lang) ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('ext.receivedAt')}</dt>
          <dd className="num">{timeWithSeconds(d.lastSeenAt, lang) ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('ext.mode')}</dt>
          <dd>{d.lastMode ? t(`ext.mode.${d.lastMode}` as MessageKey) : '—'}</dd>
        </div>
        <div>
          <dt>{t('risk.final')}</dt>
          <dd>{st?.latest.water_level?.source === 'device' ? <RiskBadge risk={st.risk.risk} /> : <span className="faint">—</span>}</dd>
        </div>
        <div>
          <dt>{t('ext.counts')}</dt>
          <dd className="num">
            {d.accepted} / <span className={d.rejected ? 'danger-text' : ''}>{d.rejected}</span>
            {d.lastResult && d.lastResult !== 'ACCEPTED' && <span className="faint"> · {t(`ext.result.${d.lastResult}` as MessageKey)}</span>}
          </dd>
        </div>
      </dl>
      {d.mqttStatus === 'offline' && <p className="faint note">{t('ext.lwtOffline')}</p>}
    </div>
  );
}

export function ExternalSensors({ compact = false }: { compact?: boolean }) {
  const { t, lang } = useI18n();
  const { live, canControl, simBusy, simCommand } = useStore();
  const snap = live.snapshot;
  const devices = snap?.devices ?? [];
  const sim = snap?.simulation;
  const source = sim?.dataSource ?? null;
  const liveRun = sim && (sim.state === 'RUNNING' || sim.state === 'PAUSED' || sim.state === 'CREATED');
  const mqtt = snap?.mqtt ?? 'disabled';
  if (compact && source !== 'EXTERNAL_SENSOR') return null;

  return (
    <section className={`card external-sensors${compact ? ' compact' : ''}`} aria-live="polite">
      <div className="card-head">
        <h2>
          <Icon name="signal" />
          {t('ext.title')}
        </h2>
        <span className={`chip mqtt-${mqtt}`} title={t('ext.mqttHint')}>
          {t(`ext.mqtt.${mqtt}` as MessageKey)}
        </span>
      </div>
      {!compact && <p className="muted">{t('ext.lead')}</p>}

      <div className={`source-line src-${source ?? 'NONE'}`}>
        <span className="eyebrow">{t('ext.sourceNow')}</span>
        <b>{source ? t(`ext.source.${source}` as MessageKey) : t('ext.source.NONE')}</b>
        {source === 'EXTERNAL_SENSOR' && sim?.run && (
          <span className="faint num">
            {' '}
            · {t('ext.scale', { s: Math.round(sim.run.tickMs / 100) / 10 })} · {t('ext.modelTime')} {dateTime(sim.run.virtualTime, lang) ?? '—'}
          </span>
        )}
      </div>

      {!compact && canControl && !liveRun && (
        <button className="btn primary" disabled={simBusy} onClick={() => void simCommand(() => api.post('/api/simulation/external/start', { hourMs: HOUR_MS }))}>
          <Icon name="signal" />
          {t('ext.start')}
        </button>
      )}
      {!compact && source === 'INTERNAL_SIMULATION' && liveRun && <div className="callout warn">{t('ext.conflict')}</div>}

      {devices.length === 0 ? (
        <p className="muted">{t('ext.none')}</p>
      ) : (
        <div className="device-list">
          {devices.map((d) => (
            <DeviceRow key={d.deviceId} d={d} />
          ))}
        </div>
      )}
      {!compact && <p className="faint note">{t('ext.how')}</p>}
    </section>
  );
}

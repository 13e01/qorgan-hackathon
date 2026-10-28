// Ручное вмешательство (POST /api/simulation/interventions, T3 §6.5). Действует со следующего часа симуляции.

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { InterventionItem, SimState } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';
import { number } from '../lib/format';
import { commandAvailable } from '../lib/sim';
import { useStore } from '../state/store';

type Kind = InterventionItem['type'];

/** Допустимые диапазоны — как в проверке сервера (routes/simulation.ts и справочник показателей). */
export const RANGES = {
  LEVEL_SHIFT: { min: -300, max: 300, unit: 'unit.cm' },
  RISE_RATE: { min: -50, max: 50, unit: 'unit.cmh' },
  water_level: { min: 0, max: 1500, unit: 'unit.cm' },
  precipitation: { min: 0, max: 100, unit: 'unit.mmh' },
  air_temp: { min: -50, max: 45, unit: 'unit.c' },
  duration: { min: 1, max: 72, unit: 'unit.h' },
} as const satisfies Record<string, { min: number; max: number; unit: MessageKey }>;

export function InterventionForm() {
  const { t, lang } = useI18n();
  const { live, stations, canControl, reportError, notify, selected } = useStore();
  const state: SimState = live.snapshot?.simulation.state ?? 'IDLE';
  const run = live.snapshot?.simulation.run ?? null;
  const [kind, setKind] = useState<Kind>('LEVEL_SHIFT');
  const [station, setStation] = useState(selected);
  const [parameter, setParameter] = useState('water_level');
  const [value, setValue] = useState('50');
  const [duration, setDuration] = useState('6');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<InterventionItem[]>([]);

  const meta = stations.find((s) => s.code === station);
  const sensors = meta?.parameters.map((p) => p.code) ?? [];
  const range = kind === 'MANUAL_READING' ? RANGES[parameter as 'water_level' | 'precipitation' | 'air_temp'] : RANGES[kind];
  const v = Number(value);
  const valueValid = value.trim() !== '' && Number.isFinite(v) && v >= range.min && v <= range.max;
  const d = Number(duration);
  const durationValid = kind !== 'RISE_RATE' || (Number.isInteger(d) && d >= RANGES.duration.min && d <= RANGES.duration.max);
  const live_ = commandAvailable('intervene', state, canControl, false);
  const nextTick = (run?.currentTick ?? -1) + 1;
  const runId = run?.id ?? null;

  useEffect(() => {
    if (kind === 'MANUAL_READING' && !sensors.includes(parameter)) setParameter('water_level');
  }, [kind, station, sensors, parameter]);

  const reload = () => {
    if (!canControl) return;
    api
      .get<{ items: InterventionItem[] }>('/api/simulation/interventions')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  };
  useEffect(reload, [runId, canControl]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valueValid || !durationValid) return;
    setBusy(true);
    try {
      const payload =
        kind === 'MANUAL_READING'
          ? { type: kind, stationCode: station, parameter, value: v }
          : kind === 'RISE_RATE'
            ? { type: kind, stationCode: station, value: v, durationH: d }
            : { type: kind, stationCode: station, value: v };
      const res = await api.post<{ effectiveTick: number }>('/api/simulation/interventions', payload);
      notify('info', t('interv.done', { tick: res.effectiveTick + 1 }));
      reload();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const disabled = !live_ || busy;
  return (
    <div className="interv">
      <form onSubmit={submit} className="stack">
        <div className="form-row">
          <div className="field">
            <label htmlFor="iv-kind">{t('interv.type')}</label>
            <select id="iv-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} disabled={disabled}>
              {(['LEVEL_SHIFT', 'RISE_RATE', 'MANUAL_READING'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`interv.type.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="iv-station">{t('interv.station')}</label>
            <select id="iv-station" value={station} onChange={(e) => setStation(e.target.value)} disabled={disabled}>
              {stations.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </div>
          {kind === 'MANUAL_READING' && (
            <div className="field">
              <label htmlFor="iv-param">{t('interv.parameter')}</label>
              <select id="iv-param" value={parameter} onChange={(e) => setParameter(e.target.value)} disabled={disabled}>
                {sensors.map((p) => (
                  <option key={p} value={p}>
                    {t(`param.${p}` as MessageKey)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="iv-value">
              {t(`interv.value.${kind}`)}
              {kind === 'MANUAL_READING' ? `, ${t(range.unit)}` : ''}
            </label>
            <input
              id="iv-value"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(',', '.'))}
              aria-invalid={!valueValid}
              aria-describedby="iv-range"
              disabled={disabled}
            />
            <span id="iv-range" className="faint">
              {t('interv.range', { min: number(range.min, lang), max: number(range.max, lang) })}
            </span>
          </div>
          {kind === 'RISE_RATE' && (
            <div className="field">
              <label htmlFor="iv-dur">{t('interv.duration')}</label>
              <input id="iv-dur" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} aria-invalid={!durationValid} disabled={disabled} />
            </div>
          )}
        </div>
        <p className="faint">{t(`interv.hint.${kind}`)}</p>
        <div className={`callout ${live_ ? 'info' : ''}`}>{live_ ? t('interv.nextTick', { tick: nextTick + 1 }) : t('interv.notLive')}</div>
        {!valueValid && value !== '' && (
          <div className="callout danger" role="alert">
            {t('interv.invalid')}
          </div>
        )}
        <div className="btn-row">
          <button type="submit" className="btn lg primary" disabled={disabled || !valueValid || !durationValid}>
            {t('interv.apply')}
          </button>
        </div>
      </form>
      {canControl && (
        <div className="section">
          <h3>{t('interv.list')}</h3>
          {items.length === 0 ? (
            <p className="muted">{t('interv.empty')}</p>
          ) : (
            <table className="table">
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="num">#{i.effectiveTick + 1}</td>
                    <td>{i.stationCode}</td>
                    <td>{t(`interv.type.${i.type}`)}</td>
                    <td className="num">
                      {number(i.value, lang)}
                      {i.durationH ? ` × ${i.durationH} ${t('unit.h')}` : ''}
                      {i.parameter ? ` (${t(`param.${i.parameter}` as MessageKey)})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

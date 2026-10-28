// Управление симуляцией через API T3. Состояние — только с сервера (снимок WebSocket); второй симулятор в браузере не создаётся.

import { useState } from 'react';
import { api } from '../api/client';
import type { ScenarioId } from '../api/shared';
import type { SimState, SimulationState } from '../api/types';
import { useI18n } from '../i18n';
import { dateTime } from '../lib/format';
import { commandAvailable, SPEED_PRESETS, type SimCommand } from '../lib/sim';
import { useStore } from '../state/store';

const SCENARIOS: ScenarioId[] = ['NORMAL', 'GRADUAL_FLOOD', 'RAPID_FLOOD'];

export function SimulationPanel({ compact = false }: { compact?: boolean }) {
  const { t, lang } = useI18n();
  const { live, canControl, reportError, setLoginOpen } = useStore();
  const sim = live.snapshot?.simulation;
  const state: SimState = sim?.state ?? 'IDLE';
  const run = sim?.run ?? null;
  const [scenario, setScenario] = useState<ScenarioId>('RAPID_FLOOD');
  const [seed, setSeed] = useState('42');
  const [tickMs, setTickMs] = useState<number>(500);
  const [busy, setBusy] = useState(false);

  const seedValue = Number(seed);
  const seedValid = seed.trim() !== '' && Number.isInteger(seedValue) && seedValue >= 0 && seedValue <= 2_147_483_647;
  const can = (c: SimCommand) => commandAvailable(c, state, canControl, busy) && (c !== 'create' && c !== 'start' ? true : state === 'CREATED' || seedValid);

  const send = async (fn: () => Promise<SimulationState | unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const body = () => ({ scenarioId: scenario, seed: seedValue, tickMs });
  const start = () => send(() => (state === 'CREATED' ? api.post('/api/simulation/start') : api.post('/api/simulation/start', body())));
  const cmd = (c: 'pause' | 'resume' | 'step' | 'stop' | 'reset') => send(() => api.post(`/api/simulation/${c}`));
  const changeSpeed = (ms: number) => {
    setTickMs(ms);
    if (commandAvailable('speed', state, canControl, false)) void send(() => api.patch('/api/simulation/speed', { tickMs: ms }));
  };
  const speedValue = run && (state === 'RUNNING' || state === 'PAUSED' || state === 'CREATED') ? run.tickMs : tickMs;

  const progress = run && run.totalTicks ? ((run.currentTick ?? -1) + 1) / run.totalTicks : 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{compact ? t('dash.simulation') : t('sim.title')}</h2>
        <div className="sim-status">
          <span className="pill">
            {t('sim.state')}: {t(`sim.state.${state}`)}
          </span>
          {run && <span className="faint">{t('sim.run', { id: run.id })} · {t(`sim.scenario.${run.scenarioId as ScenarioId}`)}</span>}
        </div>
      </div>

      {run && (
        <div style={{ marginBottom: 12 }}>
          <div className="sim-status" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="num">
              {t('top.simTime')}: <b>{run.virtualTime ? dateTime(run.virtualTime, lang, true) : t('top.simTimeNone')}</b>
            </span>
            <span className="faint num">
              {t('sim.progress', { tick: (run.currentTick ?? -1) + 1, total: run.totalTicks ?? '—' })} · {t('sim.acceleration', { x: run.acceleration })}
            </span>
          </div>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          {run.lastError === 'SERVER_RESTART' && state === 'PAUSED' && (
            <div className="callout info" style={{ marginTop: 8 }}>
              {t('sim.restartPaused')}
            </div>
          )}
          {run.lastError && run.lastError !== 'SERVER_RESTART' && (
            <div className="callout danger" style={{ marginTop: 8 }}>
              {t('sim.lastError', { error: run.lastError })}
            </div>
          )}
        </div>
      )}

      {!canControl && (
        <div className="callout info" style={{ marginBottom: 12 }}>
          {t('sim.loginRequired')}{' '}
          <button className="btn sm" onClick={() => setLoginOpen(true)}>
            {t('auth.login')}
          </button>
        </div>
      )}

      <div className="form-row" style={{ marginBottom: 12 }}>
        <div className="field">
          <label htmlFor={`sc-${compact}`}>{t('sim.scenario')}</label>
          <select id={`sc-${compact}`} value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioId)} disabled={!commandAvailable('create', state, canControl, busy)}>
            {SCENARIOS.map((s) => (
              <option key={s} value={s}>
                {t(`sim.scenario.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {!compact && (
          <div className="field">
            <label htmlFor="seed">{t('sim.seed')}</label>
            <input
              id="seed"
              inputMode="numeric"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              aria-invalid={!seedValid}
              disabled={!commandAvailable('create', state, canControl, busy)}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor={`sp-${compact}`}>{t('sim.speed')}</label>
          <select id={`sp-${compact}`} value={speedValue} onChange={(e) => changeSpeed(Number(e.target.value))} disabled={!canControl || busy}>
            {SPEED_PRESETS.map((ms) => (
              <option key={ms} value={ms}>
                {t('sim.speedOption', { ms })}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!compact && <p className="faint" style={{ marginBottom: 12 }}>{t(`sim.scenarioHint.${scenario}`)}</p>}

      <div className="btn-row">
        {!compact && (
          <button className="btn" disabled={!can('create')} onClick={() => void send(() => api.post('/api/simulation/runs', body()))}>
            {t('sim.create')}
          </button>
        )}
        <button className="btn primary" disabled={!can('start')} onClick={() => void start()}>
          {t('sim.start')}
        </button>
        <button className="btn" disabled={!can('pause')} onClick={() => void cmd('pause')}>
          {t('sim.pause')}
        </button>
        <button className="btn" disabled={!can('resume')} onClick={() => void cmd('resume')}>
          {t('sim.resume')}
        </button>
        <button className="btn" disabled={!can('step')} onClick={() => void cmd('step')}>
          {t('sim.step')}
        </button>
        <button className="btn danger" disabled={!can('stop')} onClick={() => void cmd('stop')}>
          {t('sim.stop')}
        </button>
        <button className="btn ghost" disabled={!can('reset')} onClick={() => void cmd('reset')}>
          {t('sim.reset')}
        </button>
      </div>
      {!compact && (
        <p className="faint" style={{ marginTop: 10 }}>
          {t('sim.hint')}
        </p>
      )}
    </div>
  );
}

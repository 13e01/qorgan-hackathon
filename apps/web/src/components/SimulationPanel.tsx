// Управление симуляцией через API T3. Состояние — только с сервера (снимок WebSocket); второй симулятор в браузере не создаётся.
// Главное — выбор сценария и крупные кнопки; повторяемость (seed), скорость, шаг, создание без запуска и сброс —
// в «Дополнительных настройках».

import { useState } from 'react';
import { api } from '../api/client';
import type { ScenarioId } from '../api/shared';
import type { SimState } from '../api/types';
import { useI18n } from '../i18n';
import { commandAvailable, SPEED_PRESETS } from '../lib/sim';
import { useStore } from '../state/store';
import { SimControls, SimProgress } from './SimControls';
import { Disclosure, Icon } from './ui';

const SCENARIOS: ScenarioId[] = ['RAPID_FLOOD', 'GRADUAL_FLOOD', 'NORMAL'];

export function SimulationPanel() {
  const { t } = useI18n();
  const { live, canControl, simBusy, simCommand } = useStore();
  const sim = live.snapshot?.simulation;
  const state: SimState = sim?.state ?? 'IDLE';
  const run = sim?.run ?? null;
  const [scenario, setScenario] = useState<ScenarioId>('RAPID_FLOOD');
  const [seed, setSeed] = useState('42');
  const [tickMs, setTickMs] = useState<number>(500);

  const seedValue = Number(seed);
  const seedValid = seed.trim() !== '' && Number.isInteger(seedValue) && seedValue >= 0 && seedValue <= 2_147_483_647;
  const can = (c: Parameters<typeof commandAvailable>[0]) => commandAvailable(c, state, canControl, simBusy);
  const canPick = commandAvailable('create', state, canControl, false);
  const post = (url: string, body?: unknown) => () => void simCommand(() => api.post(url, body));
  const changeSpeed = (ms: number) => {
    setTickMs(ms);
    if (commandAvailable('speed', state, canControl, false)) void simCommand(() => api.patch('/api/simulation/speed', { tickMs: ms }));
  };
  const speedValue = run && (state === 'RUNNING' || state === 'PAUSED' || state === 'CREATED') ? run.tickMs : tickMs;

  return (
    <section className="card sim-main">
      <div className="card-head">
        <h2>{t('sim.title')}</h2>
      </div>

      <fieldset className="scenario-pick" disabled={!canPick}>
        <legend className="eyebrow">{t('sim.scenario')}</legend>
        {SCENARIOS.map((s) => (
          <label key={s} className={`scenario-option${scenario === s ? ' checked' : ''}`}>
            <input type="radio" name="scenario" value={s} checked={scenario === s} onChange={() => setScenario(s)} />
            <span className="scenario-name">{t(`sim.scenario.${s}`)}</span>
            <span className="scenario-hint">{t(`sim.scenarioHint.${s}`)}</span>
          </label>
        ))}
      </fieldset>

      <div className="btn-row">
        <SimControls params={{ scenarioId: scenario, seed: seedValue, tickMs }} disabledStart={!seedValid} />
      </div>

      <SimProgress />
      {run?.lastError === 'SERVER_RESTART' && state === 'PAUSED' && <div className="callout info">{t('sim.restartPaused')}</div>}
      {run?.lastError && run.lastError !== 'SERVER_RESTART' && <div className="callout danger">{t('sim.lastError', { error: run.lastError })}</div>}
      <p className="faint">{t('ctl.stopHint')}</p>

      <Disclosure title={t('sim.advanced')} hint={t('sim.advancedHint')}>
        <div className="settings">
          <div className="field">
            <label htmlFor="seed">{t('sim.seed')}</label>
            <input id="seed" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value)} aria-invalid={!seedValid} aria-describedby="seed-hint" disabled={!canPick} />
            <span id="seed-hint" className="faint">
              {t('sim.seedHint')}
            </span>
          </div>
          <div className="field">
            <label htmlFor="speed">{t('sim.speed')}</label>
            <select id="speed" value={speedValue} onChange={(e) => changeSpeed(Number(e.target.value))} disabled={!canControl || simBusy} aria-describedby="speed-hint">
              {SPEED_PRESETS.map((ms) => (
                <option key={ms} value={ms}>
                  {t(`speed.${ms}`)}
                </option>
              ))}
            </select>
            <span id="speed-hint" className="faint">
              {t('sim.speedHint')}
            </span>
          </div>
        </div>
        <div className="setting-row">
          <button className="btn" disabled={!can('step')} onClick={post('/api/simulation/step')}>
            <Icon name="chevronRight" />
            {t('sim.step')}
          </button>
          <span className="faint">{t('sim.stepHint')}</span>
        </div>
        <div className="setting-row">
          <button className="btn" disabled={!can('create') || !seedValid} onClick={post('/api/simulation/runs', { scenarioId: scenario, seed: seedValue, tickMs })}>
            {t('sim.create')}
          </button>
          <span className="faint">{t('sim.createHint')}</span>
        </div>
        <div className="setting-row">
          <button className="btn danger" disabled={!can('reset')} onClick={post('/api/simulation/reset')}>
            <Icon name="restart" />
            {t('sim.reset')}
          </button>
          <span className="faint">{t('sim.resetHint')}</span>
        </div>
      </Disclosure>
    </section>
  );
}

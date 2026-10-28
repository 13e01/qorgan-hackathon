// Крупные кнопки управления симуляцией. Показываются только действия, возможные в текущем состоянии сервера:
// не запущена → «Запустить паводок»; идёт → «Пауза», «Остановить»; пауза → «Продолжить», «Остановить»;
// завершена/остановлена → «Начать заново». Все команды — через общий CommandGate (нет двойного запуска).

import { api } from '../api/client';
import type { ScenarioId } from '../api/shared';
import type { SimState } from '../api/types';
import { useI18n } from '../i18n';
import { DEMO_RUN } from '../lib/demo';
import { dateTime } from '../lib/format';
import { useStore } from '../state/store';
import { Icon } from './ui';

export interface StartParams {
  scenarioId: ScenarioId;
  seed: number;
  tickMs: number;
}

const DEFAULT_START: StartParams = { scenarioId: DEMO_RUN.scenarioId, seed: DEMO_RUN.seed, tickMs: DEMO_RUN.tickMs };

export function SimControls({ params = DEFAULT_START, startPrimary = true, disabledStart = false }: { params?: StartParams; startPrimary?: boolean; disabledStart?: boolean }) {
  const { t } = useI18n();
  const { live, canControl, simBusy, simCommand, setLoginOpen, authReady } = useStore();
  const state: SimState = live.snapshot?.simulation.state ?? 'IDLE';

  if (!canControl) {
    return (
      <button className="btn lg" onClick={() => setLoginOpen(true)} disabled={!authReady}>
        <Icon name="user" />
        {t('ctl.login')}
      </button>
    );
  }

  const post = (url: string, body?: unknown) => () => void simCommand(() => api.post(url, body));
  const start = post('/api/simulation/start', { ...params });

  return (
    <>
      {(state === 'IDLE' || state === 'COMPLETED' || state === 'STOPPED') && (
        <button className={`btn lg ${startPrimary ? 'primary' : ''}`} disabled={simBusy || disabledStart} onClick={start}>
          <Icon name={state === 'IDLE' ? 'play' : 'restart'} />
          {state === 'IDLE' ? t('ctl.flood') : t('ctl.restart')}
        </button>
      )}
      {state === 'CREATED' && (
        <button className="btn lg primary" disabled={simBusy} onClick={post('/api/simulation/start')}>
          <Icon name="play" />
          {t('ctl.startCreated')}
        </button>
      )}
      {state === 'RUNNING' && (
        <button className="btn lg" disabled={simBusy} onClick={post('/api/simulation/pause')}>
          <Icon name="pause" />
          {t('ctl.pause')}
        </button>
      )}
      {state === 'PAUSED' && (
        <button className="btn lg primary" disabled={simBusy} onClick={post('/api/simulation/resume')}>
          <Icon name="play" />
          {t('ctl.resume')}
        </button>
      )}
      {(state === 'RUNNING' || state === 'PAUSED' || state === 'CREATED') && (
        <button className="btn lg danger" disabled={simBusy} onClick={post('/api/simulation/stop')}>
          <Icon name="stop" />
          {t('ctl.stop')}
        </button>
      )}
    </>
  );
}

/** Ход прогона: сценарий, время симуляции, прогресс. */
export function SimProgress() {
  const { t, lang } = useI18n();
  const { live } = useStore();
  const sim = live.snapshot?.simulation;
  const run = sim?.run;
  if (!sim || !run) return null;
  const pct = run.totalTicks ? Math.round((((run.currentTick ?? -1) + 1) / run.totalTicks) * 100) : 0;
  const scenario = run.scenarioId === 'TEST_FIXTURE' ? 'TEST_FIXTURE' : t(`sim.scenario.${run.scenarioId as ScenarioId}`);
  return (
    <div className="sim-progress">
      <div className="sim-progress-row">
        <span>
          <b>{scenario}</b> <span className="faint">· {t(`sim.state.${sim.state}`)}</span>
        </span>
        <span className="num faint">
          {run.virtualTime ? dateTime(run.virtualTime, lang) : t('top.simTimeNone')} · {t('ctl.progress', { pct })}
        </span>
      </div>
      <div className="bar" role="progressbar" aria-label={t('ctl.progress', { pct })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

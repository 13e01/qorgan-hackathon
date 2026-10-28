// Панель «Демо за 2 минуты»: текущий этап, короткое пояснение, управление. Тексты этапов подставляют станции
// и уровни риска только из текущего снимка сервера; этап меняется, когда его подтверждают данные (lib/demo.ts).

import { useEffect, useRef } from 'react';
import type { ScenarioId } from '../api/shared';
import { useI18n } from '../i18n';
import { DEMO_STAGES } from '../lib/demo';
import { levelView } from '../lib/level';
import { useDemo } from '../state/demo';
import { useStore } from '../state/store';
import { SimProgress } from './SimControls';
import { Icon } from './ui';

function ConflictDialog() {
  const { t } = useI18n();
  const { live, simBusy } = useStore();
  const { demo, continueExisting, restart, cancelConflict } = useDemo();
  const ref = useRef<HTMLDialogElement>(null);
  const open = demo.phase === 'conflict';
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const sim = live.snapshot?.simulation;
  const run = sim?.run;
  return (
    <dialog ref={ref} onClose={cancelConflict} aria-labelledby="demo-conflict-title" className="dialog-wide">
      <h2 id="demo-conflict-title">{t('demo.conflict.title')}</h2>
      {run && sim && (
        <p className="muted">
          {t('demo.conflict.text', {
            id: run.id,
            scenario: run.scenarioId === 'TEST_FIXTURE' ? 'TEST_FIXTURE' : t(`sim.scenario.${run.scenarioId as ScenarioId}`),
            state: t(`sim.state.${sim.state}`).toLowerCase(),
          })}
        </p>
      )}
      <div className="dialog-actions">
        <button className="btn lg primary" disabled={simBusy} onClick={continueExisting}>
          <Icon name="play" />
          {t('demo.conflict.continue')}
        </button>
        <button className="btn lg" disabled={simBusy} onClick={restart}>
          <Icon name="restart" />
          {t('demo.conflict.restart')}
        </button>
        <button className="btn ghost" onClick={cancelConflict}>
          {t('auth.cancel')}
        </button>
      </div>
      <p className="faint">{t('demo.conflict.note')}</p>
    </dialog>
  );
}

export function DemoPanel() {
  const { t, reason } = useI18n();
  const { live, stations, simBusy } = useStore();
  const { demo, finished, pause, resume, exit, replay } = useDemo();
  if (demo.phase !== 'active') return <ConflictDialog />;

  const snap = live.snapshot;
  const sim = snap?.simulation;
  const sameRun = sim?.run?.id === demo.runId;
  const state = sameRun ? sim!.state : 'STOPPED';
  const ended = finished || state === 'STOPPED' || state === 'COMPLETED';
  const idx = DEMO_STAGES.indexOf(demo.stage.stage);
  const code = demo.stage.stationCode;
  const station = code ? stations.find((s) => s.code === code) : undefined;
  const stSnap = code ? snap?.stations.find((s) => s.code === code) : undefined;
  const name = station?.name ?? code ?? '';

  let message: string;
  switch (demo.stage.stage) {
    case 'normal':
      message = t('demo.msg.normal');
      break;
    case 'rising':
      message = t('demo.msg.rising', { station: name });
      break;
    case 'risk':
      message = t('demo.msg.risk', { station: name, risk: stSnap ? t(`risk.${stSnap.risk.risk}`) : '—' });
      break;
    case 'wave':
      message = t('demo.msg.wave', { station: name });
      break;
    case 'explain':
      message = t('demo.msg.explain', { station: name });
      break;
  }
  const explainReasons = demo.stage.stage === 'explain' && stSnap ? stSnap.risk.topReasons.slice(0, 3) : [];
  const withData = (snap?.stations ?? []).filter((s) => levelView(s).measuredCm !== null);
  const danger = withData.filter((s) => s.risk.situation.localLevel === 'ABOVE_DANGER').length;
  const warning = withData.filter((s) => s.risk.situation.localLevel === 'ABOVE_WARNING').length;

  return (
    <section className="demo-panel" aria-labelledby="demo-title" aria-live="polite">
      <ConflictDialog />
      <div className="demo-head">
        <div className="demo-badge">
          <Icon name="sparkle" />
          <span id="demo-title">{t('demo.title')}</span>
        </div>
        <span className="faint">{t('demo.step', { n: idx + 1, total: DEMO_STAGES.length })}</span>
      </div>
      <ol className="demo-steps">
        {DEMO_STAGES.map((s, i) => (
          <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>
            <span className="demo-step-bar" />
            <span className="demo-step-label">{t(`demo.stage.${s}`)}</span>
          </li>
        ))}
      </ol>
      <div className="demo-body">
        <div className="demo-text">
          <h2 className="demo-stage">{t(`demo.stage.${demo.stage.stage}`)}</h2>
          <p className="demo-message">{message}</p>
          {explainReasons.length > 0 && (
            <ul className="reasons">
              {explainReasons.map((r, i) => (
                <li key={i}>{reason(r)}</li>
              ))}
            </ul>
          )}
          {demo.stage.stage === 'explain' && <p className="demo-summary">{t('demo.summary', { danger, warning, total: withData.length })}</p>}
          {finished && <p className="callout ok">{t('demo.finished')}</p>}
          {state === 'PAUSED' && <p className="callout info">{t('demo.paused')}</p>}
        </div>
        <div className="demo-actions">
          {!ended && state === 'RUNNING' && (
            <button className="btn lg" disabled={simBusy} onClick={pause}>
              <Icon name="pause" />
              {t('ctl.pause')}
            </button>
          )}
          {!ended && state === 'PAUSED' && (
            <button className="btn lg primary" disabled={simBusy} onClick={resume}>
              <Icon name="play" />
              {t('ctl.resume')}
            </button>
          )}
          {ended && (
            <button className="btn lg primary" disabled={simBusy} onClick={replay}>
              <Icon name="restart" />
              {t('demo.replay')}
            </button>
          )}
          <button className="btn lg ghost" disabled={simBusy} onClick={exit} aria-describedby="demo-exit-hint">
            <Icon name="close" />
            {t('demo.exit')}
          </button>
        </div>
      </div>
      {sameRun && <SimProgress />}
      <p className="faint">
        {t('demo.real')} <span id="demo-exit-hint">{t('demo.exitHint')}</span>
      </p>
    </section>
  );
}

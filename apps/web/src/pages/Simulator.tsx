import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ScenarioId } from '../api/shared';
import type { RunInfo } from '../api/types';
import { InterventionForm } from '../components/InterventionForm';
import { SimulationPanel } from '../components/SimulationPanel';
import { StationList } from '../components/StationList';
import { Disclosure } from '../components/ui';
import { useI18n } from '../i18n';
import { dateTime } from '../lib/format';
import { useStore } from '../state/store';

function RunHistory() {
  const { t, lang } = useI18n();
  const { canControl, live } = useStore();
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const stateKey = `${live.snapshot?.simulation.state}:${live.snapshot?.simulation.run?.id}`;
  useEffect(() => {
    if (!canControl) return;
    api
      .get<{ items: RunInfo[] }>('/api/simulation/runs')
      .then((r) => setRuns(r.items))
      .catch(() => setRuns([]));
  }, [canControl, stateKey]);
  if (!canControl) return null;
  return (
    <div className="table-wrap">
      {!runs ? (
        <p className="muted">{t('common.loading')}</p>
      ) : runs.length === 0 ? (
        <p className="muted">{t('sim.noRun')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('sim.col.run')}</th>
              <th>{t('sim.col.scenario')}</th>
              <th>{t('sim.col.status')}</th>
              <th>{t('sim.col.progress')}</th>
              <th>{t('sim.col.started')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="num">#{r.id}</td>
                <td>{r.scenarioId === 'TEST_FIXTURE' ? 'TEST_FIXTURE' : t(`sim.scenario.${r.scenarioId as ScenarioId}`)}</td>
                <td>{t(`sim.state.${r.status}`)}</td>
                <td className="num">
                  {r.currentTick === null ? '—' : r.currentTick + 1} / {r.totalTicks ?? '—'}
                </td>
                <td className="num">{dateTime(r.startedAt, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Simulator() {
  const { t } = useI18n();
  const { canControl } = useStore();
  return (
    <div className="sim-page">
      <div className="sim-grid">
        <SimulationPanel />
        <StationList />
      </div>
      {canControl && (
        <Disclosure className="card" title={t('interv.title')} hint={t('sim.manualHint')}>
          <InterventionForm />
        </Disclosure>
      )}
      {canControl && (
        <Disclosure className="card" title={t('sim.history')} hint={t('sim.historyHint')}>
          <RunHistory />
        </Disclosure>
      )}
    </div>
  );
}

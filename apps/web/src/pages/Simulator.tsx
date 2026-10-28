import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ScenarioId } from '../api/shared';
import type { RunInfo } from '../api/types';
import { InterventionForm } from '../components/InterventionForm';
import { SimulationPanel } from '../components/SimulationPanel';
import { StationStrip } from './Dashboard';
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
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="panel-head">
        <h2>{t('sim.history')}</h2>
      </div>
      {!runs ? (
        <p className="muted">{t('common.loading')}</p>
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="sim-grid">
        <SimulationPanel />
        <InterventionForm />
      </div>
      <StationStrip />
      <RunHistory />
    </div>
  );
}

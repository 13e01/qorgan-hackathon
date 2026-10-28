// Состояние «Демо за 2 минуты» для React: обёртка над DemoController (lib/demo.ts).
// Этапы двигаются только по снимкам WebSocket; своих таймеров нет — после выхода ничего не продолжает работать.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { SimState } from '../api/types';
import { DemoController, type DemoState, type SimView } from '../lib/demo';
import { browserStore } from '../lib/prefs';
import { useStore } from './store';

interface DemoCtx {
  demo: DemoState;
  /** Прогон демо завершился сам (дошёл до конца сценария). */
  finished: boolean;
  begin: () => void;
  continueExisting: () => void;
  restart: () => void;
  cancelConflict: () => void;
  replay: () => void;
  pause: () => void;
  resume: () => void;
  exit: () => void;
}

const Ctx = createContext<DemoCtx | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const { live, stations, gate, reportError, canControl, setLoginOpen, authReady } = useStore();
  const [demo, setDemo] = useState<DemoState>({ phase: 'off', runId: null, stage: { stage: 'normal', stationCode: null } });
  const controller = useMemo(() => new DemoController(api, gate, browserStore(), setDemo), [gate]);

  const sim = live.snapshot?.simulation;
  const state: SimState = sim?.state ?? 'IDLE';
  const runId = sim?.run?.id ?? null;
  const simRef = useRef<SimView>({ state, runId });
  simRef.current = { state, runId };

  // Восстановление после перезагрузки — один раз, когда пришёл первый снимок.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !live.snapshot) return;
    restored.current = true;
    controller.restore(simRef.current);
  }, [live.snapshot, controller]);

  useEffect(() => {
    if (live.snapshot && stations.length > 0) controller.onSnapshot(live.snapshot, stations);
  }, [live.snapshot, stations, controller]);

  const guard = useCallback(
    (fn: (sim: SimView) => Promise<void> | void) => () => {
      if (!canControl) {
        if (authReady) setLoginOpen(true);
        return;
      }
      Promise.resolve(fn(simRef.current)).catch(reportError);
    },
    [canControl, authReady, setLoginOpen, reportError],
  );

  const value = useMemo<DemoCtx>(
    () => ({
      demo,
      finished: demo.phase === 'active' && demo.runId === runId && state === 'COMPLETED',
      begin: guard((s) => {
        location.hash = '#/dashboard';
        return controller.begin(s);
      }),
      continueExisting: guard((s) => controller.continueExisting(s)),
      restart: guard((s) => controller.restart(s)),
      cancelConflict: () => controller.cancelConflict(),
      replay: guard((s) => controller.replay(s)),
      pause: guard(() => controller.pause()),
      resume: guard(() => controller.resume()),
      exit: guard((s) => controller.exit(s)),
    }),
    [demo, runId, state, guard, controller],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDemo(): DemoCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDemo outside DemoProvider');
  return ctx;
}

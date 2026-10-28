// Общее состояние интерфейса: пользователь, станции, живые данные (WebSocket), выбор станции, уведомления.
// Источник истины — сервер: после перезагрузки страницы или восстановления связи всё берётся заново из API/WS.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { PublicUser } from '../api/shared';
import type { MeasurementsResponse, RiskHistoryResponse, ScenarioInfo, Snapshot, StationMeta } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';
import { CommandGate } from '../lib/gate';
import { applySnapshot, initialLive, needsReload, setLevelHistory, setRiskHistory, type LiveState } from './live';
import { LiveSocket, type ConnectionStatus } from './socket';

type LiveAction =
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'levels'; code: string; runId: number | null; data: MeasurementsResponse['items'] }
  | { type: 'risks'; code: string; runId: number | null; data: RiskHistoryResponse['items'] }
  | { type: 'invalidate' };

function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'snapshot':
      return applySnapshot(state, action.snap);
    case 'levels':
      return setLevelHistory(state, action.code, action.runId, action.data);
    case 'risks':
      return setRiskHistory(state, action.code, action.runId, action.data);
    case 'invalidate':
      return { ...state, levels: {}, risks: {} };
  }
}

export interface Notice {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

interface Store {
  user: PublicUser | null;
  authReady: boolean;
  canControl: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loginOpen: boolean;
  setLoginOpen: (open: boolean) => void;
  stations: StationMeta[];
  stationsError: string | null;
  scenarios: ScenarioInfo[];
  live: LiveState;
  connection: ConnectionStatus;
  selected: string;
  select: (code: string) => void;
  notices: Notice[];
  notify: (kind: Notice['kind'], text: string) => void;
  dismiss: (id: number) => void;
  /** Текст ошибки API на выбранном языке; 401 открывает окно входа. */
  describeError: (err: unknown) => string;
  reportError: (err: unknown) => void;
  /** Общая защита от двойного нажатия для всех команд симулятора (кнопки, демо). */
  gate: CommandGate;
  simBusy: boolean;
  /** Отправить команду симулятора; пока предыдущая не завершилась, новая не отправляется. Ошибка показывается пользователю. */
  simCommand: (fn: () => Promise<unknown>) => Promise<boolean>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [stations, setStations] = useState<StationMeta[]>([]);
  const [stationsError, setStationsError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [live, dispatch] = useReducer(liveReducer, initialLive);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [selected, setSelected] = useState('QRG-01');
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const gate = useMemo(() => new CommandGate(), []);
  const [simBusy, setSimBusy] = useState(false);
  useEffect(() => gate.subscribe(setSimBusy), [gate]);

  const describeError = useCallback(
    (err: unknown) => {
      const code = err instanceof ApiError ? err.code : 'NETWORK';
      const key = `error.${code}` as MessageKey;
      const known = t(key);
      return known === key ? t('error.default', { code }) : known;
    },
    [t],
  );

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    noticeId.current += 1;
    const id = noticeId.current;
    setNotices((list) => [...list.slice(-3), { id, kind, text }]);
    setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  const dismiss = useCallback((id: number) => setNotices((list) => list.filter((n) => n.id !== id)), []);

  const reportError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) setLoginOpen(true);
      notify('error', describeError(err));
    },
    [describeError, notify],
  );

  const simCommand = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        return (await gate.run(fn)) !== null;
      } catch (err) {
        reportError(err);
        return false;
      }
    },
    [gate, reportError],
  );

  const loadStations = useCallback(async () => {
    try {
      const res = await api.get<{ items: StationMeta[] }>('/api/stations');
      setStations(res.items);
      setStationsError(null);
    } catch (err) {
      setStationsError(describeError(err));
    }
  }, [describeError]);

  // Начальная загрузка: кто вошёл, станции, сценарии; WebSocket.
  useEffect(() => {
    api
      .get<{ user: PublicUser | null }>('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setAuthReady(true));
    void loadStations();
    api
      .get<{ items: ScenarioInfo[] }>('/api/simulation/scenarios')
      .then((r) => setScenarios(r.items))
      .catch(() => undefined);
    const socket = new LiveSocket((snap) => dispatch({ type: 'snapshot', snap }), setConnection);
    socket.start();
    return () => socket.stop();
  }, [loadStations]);

  // После восстановления связи — свежие станции и истории (за время обрыва могли прийти тики).
  const prevConnection = useRef<ConnectionStatus>('connecting');
  useEffect(() => {
    if (connection === 'open' && prevConnection.current === 'closed') {
      void loadStations();
      dispatch({ type: 'invalidate' });
    }
    prevConnection.current = connection;
  }, [connection, loadStations]);

  // Истории для графиков: при смене прогона, роли или после обрыва связи. Дальше — дополняются из снимков.
  const runId = live.snapshot?.context.runId ?? null;
  const role = user?.role ?? 'guest';
  const loading = useRef(new Set<string>());
  useEffect(() => {
    if (!live.snapshot) return;
    for (const st of stations) {
      const levelKey = `L:${st.code}:${runId}:${role}`;
      if (needsReload(live.levels[st.code], runId) && !loading.current.has(levelKey)) {
        loading.current.add(levelKey);
        const q = runId === null ? '' : `&runId=${runId}`;
        const url = `/api/stations/${st.code}/measurements?parameter=water_level&limit=2000${role === 'guest' ? '' : q}`;
        api
          .get<MeasurementsResponse>(url)
          .then((r) => dispatch({ type: 'levels', code: st.code, runId: r.context.runId, data: r.items }))
          .catch(() => dispatch({ type: 'levels', code: st.code, runId, data: [] }))
          .finally(() => loading.current.delete(levelKey));
      }
      const riskKey = `R:${st.code}:${runId}:${role}`;
      if (needsReload(live.risks[st.code], runId) && !loading.current.has(riskKey)) {
        loading.current.add(riskKey);
        if (role === 'guest' || runId === null) {
          // История оценок — только оператору; гостю шкала заполняется по мере прихода снимков.
          dispatch({ type: 'risks', code: st.code, runId, data: [] });
          loading.current.delete(riskKey);
        } else {
          api
            .get<RiskHistoryResponse>(`/api/stations/${st.code}/risk/history?runId=${runId}&limit=2000`)
            .then((r) => dispatch({ type: 'risks', code: st.code, runId, data: r.items }))
            .catch(() => dispatch({ type: 'risks', code: st.code, runId, data: [] }))
            .finally(() => loading.current.delete(riskKey));
        }
      }
    }
  }, [live.snapshot, live.levels, live.risks, stations, runId, role]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<{ user: PublicUser }>('/api/auth/login', { username, password });
    setUser(res.user);
    setLoginOpen(false);
    dispatch({ type: 'invalidate' });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setUser(null);
      dispatch({ type: 'invalidate' });
      notify('info', t('auth.loggedOut'));
    }
  }, [notify, t]);

  const value = useMemo<Store>(
    () => ({
      user,
      authReady,
      canControl: user !== null,
      login,
      logout,
      loginOpen,
      setLoginOpen,
      stations,
      stationsError,
      scenarios,
      live,
      connection,
      selected,
      select: setSelected,
      notices,
      notify,
      dismiss,
      describeError,
      reportError,
      gate,
      simBusy,
      simCommand,
    }),
    [user, authReady, login, logout, loginOpen, stations, stationsError, scenarios, live, connection, selected, notices, notify, dismiss, describeError, reportError, gate, simBusy, simCommand],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useStore outside StoreProvider');
  return ctx;
}

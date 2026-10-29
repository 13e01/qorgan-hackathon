// Звуковые предупреждения в интерфейсе: настройка (вкл/выкл, громкость) в браузере, воспроизведение по снимкам
// сервера (lib/sound.ts решает, когда звучать). Звук не включается сам: по умолчанию выключен, а AudioContext
// создаётся только после нажатия пользователя (включение звука, «Проверить» или первое действие на странице).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browserStore } from '../lib/prefs';
import { readSoundPrefs, SoundEngine, SoundGate, soundForSnapshot, writeSoundPrefs, type SeenAlerts, type SoundKind, type SoundPrefs } from '../lib/sound';
import { useStore } from './store';

interface SoundApi {
  prefs: SoundPrefs;
  supported: boolean;
  /** Звук включён, но браузер ещё не разрешил воспроизведение (нужно любое нажатие на странице). */
  locked: boolean;
  setEnabled: (on: boolean) => Promise<void>;
  setVolume: (v: number) => void;
  test: (kind: SoundKind) => Promise<void>;
  /** Последний воспроизведённый сигнал (для экранных дикторов и проверки). */
  lastPlayed: { kind: SoundKind; at: number } | null;
}

const Ctx = createContext<SoundApi | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  const { live } = useStore();
  const engine = useMemo(() => new SoundEngine(), []);
  const gate = useMemo(() => new SoundGate(), []);
  const [prefs, setPrefs] = useState<SoundPrefs>(() => readSoundPrefs(browserStore()));
  const [ready, setReady] = useState(false);
  const [lastPlayed, setLastPlayed] = useState<SoundApi['lastPlayed']>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const save = useCallback((next: SoundPrefs) => {
    setPrefs(next);
    writeSoundPrefs(browserStore(), next);
  }, []);

  const unlock = useCallback(async () => {
    const ok = await engine.unlock();
    setReady(ok);
    return ok;
  }, [engine]);

  // Звук был включён раньше: браузер разрешит его после первого действия пользователя на странице.
  useEffect(() => {
    if (!prefs.enabled || ready) return;
    const once = () => void unlock();
    window.addEventListener('pointerdown', once, { once: true });
    window.addEventListener('keydown', once, { once: true });
    return () => {
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
    };
  }, [prefs.enabled, ready, unlock]);

  const play = useCallback(
    (kind: SoundKind, force = false) => {
      const p = prefsRef.current;
      if (!force && (!p.enabled || !gate.allow(kind, Date.now()))) return;
      if (engine.play(kind, p.volume)) setLastPlayed({ kind, at: Date.now() });
    },
    [engine, gate],
  );

  // Новые / обострившиеся предупреждения — по снимкам сервера; первый снимок только запоминается.
  const seen = useRef<SeenAlerts | null>(null);
  const alerts = live.snapshot?.alerts;
  useEffect(() => {
    if (!alerts) return;
    const { kind, seen: next } = soundForSnapshot(seen.current, alerts.runId, alerts.active);
    seen.current = next;
    if (kind) play(kind);
  }, [alerts, play]);

  const value = useMemo<SoundApi>(
    () => ({
      prefs,
      supported: engine.supported,
      locked: prefs.enabled && !ready,
      setEnabled: async (on) => {
        save({ ...prefsRef.current, enabled: on });
        if (on) await unlock();
      },
      setVolume: (v) => save({ ...prefsRef.current, volume: Math.min(1, Math.max(0, v)) }),
      test: async (kind) => {
        if (await unlock()) play(kind, true);
      },
      lastPlayed,
    }),
    [prefs, engine, ready, save, unlock, play, lastPlayed],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSound(): SoundApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSound outside SoundProvider');
  return ctx;
}

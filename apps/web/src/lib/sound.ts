// Звуковые предупреждения (docs/SENTINEL_ARCHITECTURE.md §7). Звуки оригинальные — синтезируются Web Audio API,
// чужих записей нет. Логика «когда звучать» — чистые функции (тестируются без браузера):
//   • звук только при НОВОМ предупреждении или повышении MEDIUM → HIGH, по снимкам сервера;
//   • не при первой загрузке страницы и не при смене прогона (то, что уже было, не «новое»);
//   • одинаковое событие не повторяется: не чаще раза в MIN_GAP_MS, HIGH может прервать паузу после MEDIUM;
//   • по умолчанию звук выключен; включение — явное действие пользователя (оно же разрешает звук в браузере).
// Звук никогда не единственный сигнал: то же событие показывается текстом (уведомление и журнал).

import type { AlertItem } from '../api/types';
import { readPref, writePref, type KeyValueStore } from './prefs';

export type SoundKind = 'MEDIUM' | 'HIGH';

export interface SoundPrefs {
  enabled: boolean;
  /** Громкость 0…1. */
  volume: number;
}

export const SOUND_KEY = 'qorgan.sound';
export const DEFAULT_SOUND: SoundPrefs = { enabled: false, volume: 0.5 };

export function readSoundPrefs(store: KeyValueStore | null): SoundPrefs {
  const raw = readPref(store, SOUND_KEY);
  if (!raw) return DEFAULT_SOUND;
  try {
    const v = JSON.parse(raw) as Partial<SoundPrefs>;
    const volume = typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_SOUND.volume;
    return { enabled: v.enabled === true, volume };
  } catch {
    return DEFAULT_SOUND;
  }
}

export function writeSoundPrefs(store: KeyValueStore | null, prefs: SoundPrefs): void {
  writePref(store, SOUND_KEY, JSON.stringify(prefs));
}

export interface SeenAlerts {
  runId: number | null;
  severity: Map<number, string>;
}

/**
 * Какой звук нужен после нового снимка. prev = null — первый снимок после загрузки: запоминаем, не звучим.
 * Возвращает самый серьёзный повод (HIGH важнее MEDIUM) и новое запомненное состояние.
 */
export function soundForSnapshot(prev: SeenAlerts | null, runId: number | null, active: readonly Pick<AlertItem, 'id' | 'severity'>[]): { kind: SoundKind | null; seen: SeenAlerts } {
  const seen: SeenAlerts = { runId, severity: new Map(active.map((a) => [a.id, a.severity])) };
  if (!prev || prev.runId !== runId) return { kind: null, seen };
  let kind: SoundKind | null = null;
  for (const a of active) {
    const before = prev.severity.get(a.id);
    const isNew = before === undefined;
    const escalated = before === 'MEDIUM' && a.severity === 'HIGH';
    if (!isNew && !escalated) continue;
    if (a.severity === 'HIGH') kind = 'HIGH';
    else if (kind === null) kind = 'MEDIUM';
  }
  return { kind, seen };
}

export const MIN_GAP_MS = 4_000;

/** Защита от повторов: не чаще раза в MIN_GAP_MS; HIGH после MEDIUM звучит сразу. */
export class SoundGate {
  private lastAt = -Infinity;
  private lastKind: SoundKind | null = null;

  allow(kind: SoundKind, nowMs: number): boolean {
    const recent = nowMs - this.lastAt < MIN_GAP_MS;
    if (recent && !(kind === 'HIGH' && this.lastKind === 'MEDIUM')) return false;
    this.lastAt = nowMs;
    this.lastKind = kind;
    return true;
  }
}

/** Ноты сигнала: [частота Гц, начало с, длительность с]. MEDIUM — два мягких тона вверх; HIGH — три коротких импульса. */
export const PATTERNS: Record<SoundKind, { wave: OscillatorType; peak: number; notes: Array<[number, number, number]> }> = {
  MEDIUM: { wave: 'sine', peak: 0.22, notes: [[659.25, 0, 0.22], [880, 0.2, 0.32]] },
  HIGH: { wave: 'triangle', peak: 0.3, notes: [[784, 0, 0.14], [988, 0.2, 0.14], [784, 0.4, 0.14], [988, 0.6, 0.22]] },
};

type AudioCtor = typeof AudioContext;

/** Проигрыватель. AudioContext создаётся только из обработчика действия пользователя (unlock) — правило автозапуска браузеров. */
export class SoundEngine {
  private ctx: AudioContext | null = null;

  constructor(private readonly Ctor: AudioCtor | null = typeof window === 'undefined' ? null : (window.AudioContext ?? null)) {}

  get supported(): boolean {
    return this.Ctor !== null;
  }

  /** Разрешено ли воспроизведение (контекст создан пользователем и не приостановлен). */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Вызывать только из обработчика нажатия/клавиши. */
  async unlock(): Promise<boolean> {
    if (!this.Ctor) return false;
    try {
      this.ctx ??= new this.Ctor();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  play(kind: SoundKind, volume: number): boolean {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || volume <= 0) return false;
    const p = PATTERNS[kind];
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = Math.min(1, Math.max(0, volume));
    master.connect(ctx.destination);
    for (const [freq, start, dur] of p.notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = p.wave;
      osc.frequency.value = freq;
      // Плавная атака и затухание — без щелчков и резкости.
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(p.peak, t0 + start + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(g).connect(master);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.05);
    }
    return true;
  }
}

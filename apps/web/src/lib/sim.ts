// Какие команды симулятора доступны — по состоянию сервера (T3, ARCHITECTURE §6.1) и роли пользователя.
// Повторяет правила сервера, чтобы не показывать заведомо отклоняемые кнопки; окончательно решает сервер.

import type { SimState } from '../api/types';

export type SimCommand = 'create' | 'start' | 'pause' | 'resume' | 'step' | 'stop' | 'reset' | 'speed' | 'intervene';

const LIVE: SimState[] = ['CREATED', 'RUNNING', 'PAUSED'];

export function commandAvailable(command: SimCommand, state: SimState, canControl: boolean, busy: boolean): boolean {
  if (!canControl || busy) return false;
  switch (command) {
    case 'create':
      return !LIVE.includes(state);
    case 'start':
      // CREATED — запуск созданного; IDLE/COMPLETED/STOPPED — создать и сразу запустить выбранный сценарий.
      return state !== 'RUNNING' && state !== 'PAUSED';
    case 'pause':
      return state === 'RUNNING';
    case 'resume':
      return state === 'PAUSED';
    case 'step':
      return state === 'PAUSED' || state === 'CREATED';
    case 'stop':
      return LIVE.includes(state);
    case 'reset':
      return state !== 'IDLE';
    case 'speed':
    case 'intervene':
      return LIVE.includes(state);
  }
}

/** Пресеты скорости: реальных миллисекунд на один виртуальный час. */
export const SPEED_PRESETS = [1000, 500, 250, 100] as const;

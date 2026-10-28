// Подключение к WebSocket /ws с автоматическим переподключением (1 → 2 → 5 → 10 с).
// Сервер сам присылает снимок сразу после подключения, поэтому после восстановления связи данные актуальны.

import type { Snapshot } from '../api/types';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

const BACKOFF_MS = [1000, 2000, 5000, 10000];

export class LiveSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly onSnapshot: (s: Snapshot) => void,
    private readonly onStatus: (s: ConnectionStatus) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.onStatus('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus('open');
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type?: string; data?: Snapshot };
        if (msg.type === 'snapshot' && msg.data) this.onSnapshot(msg.data);
      } catch {
        // повреждённое сообщение пропускаем — следующее придёт с новым тиком
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    // Закрытие ещё не открытого соединения браузер считает ошибкой — закрываем сразу после открытия.
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
    else ws.close();
  }
}

// Рассылка обновлений по WebSocket. Только сервер → клиент; команды идут через REST.

import type { WebSocket } from 'ws';

export class RealtimeHub {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly buildSnapshot: () => unknown) {}

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
    this.send(socket, { type: 'snapshot', data: this.buildSnapshot() });
  }

  /** Новый снимок всем клиентам; если клиентов нет, снимок не строится. */
  broadcastSnapshot(event: unknown = null): void {
    if (this.clients.size === 0) return;
    const message = { type: 'snapshot', event, data: this.buildSnapshot() };
    for (const socket of this.clients) this.send(socket, message);
  }

  closeAll(): void {
    for (const socket of this.clients) socket.close(1001, 'server shutdown');
    this.clients.clear();
  }

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}

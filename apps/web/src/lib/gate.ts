// Защита от двойного нажатия: одновременно выполняется не больше одной команды симулятора.
// Повторный вызов, пока идёт предыдущий, не отправляет второй запрос, а возвращает null.

export class CommandGate {
  private current: Promise<unknown> | null = null;
  private readonly listeners = new Set<(busy: boolean) => void>();

  get busy(): boolean {
    return this.current !== null;
  }

  subscribe(fn: (busy: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.current) return null;
    const p = fn();
    this.current = p;
    this.emit();
    try {
      return await p;
    } finally {
      this.current = null;
      this.emit();
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.busy);
  }
}

export type RecordingPauseGateState = "running" | "paused" | "cancelled";

export class RecordingPauseCancelledError extends Error {
  constructor() {
    super("recording pause gate was cancelled");
    this.name = "RecordingPauseCancelledError";
  }
}

export class RecordingPauseGate {
  #state: RecordingPauseGateState = "running";
  #waiters = new Set<(running: boolean) => void>();
  #stateListeners = new Set<() => void>();

  get state(): RecordingPauseGateState {
    return this.#state;
  }

  pause(): void {
    if (this.#state !== "running") return;
    this.#state = "paused";
    this.#notifyStateChange();
  }

  resume(): void {
    if (this.#state !== "paused") return;
    this.#state = "running";
    this.#notifyStateChange();
    this.#resolveWaiters(true);
  }

  cancel(): void {
    if (this.#state === "cancelled") return;
    this.#state = "cancelled";
    this.#notifyStateChange();
    this.#resolveWaiters(false);
  }

  waitUntilRunning(): Promise<boolean> {
    if (this.#state === "running") return Promise.resolve(true);
    if (this.#state === "cancelled") return Promise.resolve(false);
    return new Promise((resolve) => this.#waiters.add(resolve));
  }

  async waitForDelay(durationMs: number): Promise<boolean> {
    let remainingMs = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
    if (remainingMs === 0) return this.waitUntilRunning();

    while (remainingMs > 0) {
      if (!(await this.waitUntilRunning())) return false;
      const startedAt = Date.now();
      await new Promise<void>((resolve) => {
        let settled = false;
        const onStateChange = () => finish();
        const timer = setTimeout(finish, remainingMs);
        this.#stateListeners.add(onStateChange);
        const gate = this;

        function finish() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          gate.#stateListeners.delete(onStateChange);
          resolve();
        }

        Promise.resolve().then(() => {
          if (this.#state !== "running") finish();
        });
      });
      remainingMs = Math.max(0, remainingMs - Math.max(0, Date.now() - startedAt));
      if (this.#state === "cancelled") return false;
    }
    return true;
  }

  #notifyStateChange(): void {
    for (const listener of this.#stateListeners) listener();
    this.#stateListeners.clear();
  }

  #resolveWaiters(running: boolean): void {
    for (const waiter of this.#waiters) waiter(running);
    this.#waiters.clear();
  }
}

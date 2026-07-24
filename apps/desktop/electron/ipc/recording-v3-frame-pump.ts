export interface RecordingV3FramePumpTarget {
  isDestroyed(): boolean;
  startPainting(): void;
  stopPainting(): void;
  invalidate(): void;
}

export type RecordingV3FramePumpDefer = (callback: () => void) => void;

export class RecordingV3FramePump {
  private running = false;
  private generation = 0;
  private pendingToken: object | null = null;

  constructor(
    private readonly target: RecordingV3FramePumpTarget,
    private readonly defer: RecordingV3FramePumpDefer = (callback) => setImmediate(callback),
  ) {}

  start(): void {
    if (this.running || this.target.isDestroyed()) return;
    this.generation += 1;
    this.running = true;
    this.target.startPainting();
    this.requestNext();
  }

  requestNext(): void {
    if (!this.running || this.pendingToken || this.target.isDestroyed()) return;
    const generation = this.generation;
    const token = {};
    this.pendingToken = token;
    this.defer(() => {
      if (this.pendingToken !== token) return;
      this.pendingToken = null;
      if (!this.running || this.generation !== generation || this.target.isDestroyed()) return;
      this.target.invalidate();
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    this.pendingToken = null;
    if (!this.target.isDestroyed()) this.target.stopPainting();
  }
}

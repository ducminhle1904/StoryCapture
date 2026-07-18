export interface TauriChannelMessage {
  index: number;
  message: unknown;
}

export interface TauriChannelEnd {
  index: number;
  end: true;
}

export class TauriChannelSequencer {
  private readonly indexes = new Map<number, number>();

  message(id: number, message: unknown): TauriChannelMessage {
    const index = this.indexes.get(id) ?? 0;
    this.indexes.set(id, index + 1);
    return { index, message };
  }

  end(id: number): TauriChannelEnd {
    const index = this.indexes.get(id) ?? 0;
    this.indexes.delete(id);
    return { index, end: true };
  }

  forget(id: number): void {
    this.indexes.delete(id);
  }
}

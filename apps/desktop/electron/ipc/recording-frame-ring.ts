import { createHash } from "node:crypto";

export interface RecordingFrameLedgerEntry {
  frame_index: number;
  source_sequence: number;
  native_pts_us: number;
  sha256: string;
}

export interface RecordingFrameInput {
  sourceSequence: number;
  nativePtsUs: number;
  pixels: Uint8Array;
}

export interface RecordingFrameLease extends RecordingFrameLedgerEntry {
  pixels: Uint8Array;
  release(): void;
}

export class RecordingFrameRingError extends Error {
  constructor(
    readonly code:
      | "frame_ring_overflow"
      | "source_sequence_missing"
      | "source_sequence_gap"
      | "artifact_pts_duplicate"
      | "artifact_pts_gap"
      | "contract_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "RecordingFrameRingError";
  }
}

/**
 * Fixed-size BGRA frame ring backed by SharedArrayBuffer. The producer copies
 * once into shared storage; the encoder consumes a view and releases the slot.
 */
export class BoundedNativeFrameRing {
  readonly slotBytes: number;
  readonly storage: SharedArrayBuffer;
  readonly states: Int32Array;
  readonly sequences: BigInt64Array;
  readonly ptsUs: BigInt64Array;

  private readonly bytes: Uint8Array;
  private readonly hashes: Array<string | null>;
  private writeIndex = 0;
  private readIndex = 0;
  private queued = 0;
  private committed = 0;
  private lastSequence: number | null = null;
  private lastPtsUs: number | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly capacity: number,
  ) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new RecordingFrameRingError(
        "contract_mismatch",
        "frame dimensions must be positive integers",
      );
    }
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new RecordingFrameRingError(
        "contract_mismatch",
        "frame ring capacity must be at least two",
      );
    }
    this.slotBytes = width * height * 4;
    this.storage = new SharedArrayBuffer(this.slotBytes * capacity);
    this.bytes = new Uint8Array(this.storage);
    this.states = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * capacity));
    this.sequences = new BigInt64Array(
      new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * capacity),
    );
    this.ptsUs = new BigInt64Array(
      new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * capacity),
    );
    this.hashes = Array.from({ length: capacity }, () => null);
  }

  get size(): number {
    return this.queued;
  }

  get remainingCapacity(): number {
    return this.capacity - this.queued;
  }

  push(frame: RecordingFrameInput): RecordingFrameLedgerEntry {
    if (!Number.isSafeInteger(frame.sourceSequence) || frame.sourceSequence <= 0) {
      throw new RecordingFrameRingError(
        "source_sequence_missing",
        "source sequence must be a positive safe integer",
      );
    }
    if (!Number.isSafeInteger(frame.nativePtsUs) || frame.nativePtsUs < 0) {
      throw new RecordingFrameRingError(
        "contract_mismatch",
        "native PTS must be a non-negative safe integer",
      );
    }
    if (frame.pixels.byteLength !== this.slotBytes) {
      throw new RecordingFrameRingError(
        "contract_mismatch",
        `BGRA frame has ${frame.pixels.byteLength} bytes; expected ${this.slotBytes}`,
      );
    }
    if (this.queued === this.capacity) {
      throw new RecordingFrameRingError("frame_ring_overflow", "recording frame ring is full");
    }
    if (this.lastSequence !== null && frame.sourceSequence !== this.lastSequence + 1) {
      throw new RecordingFrameRingError(
        "source_sequence_gap",
        `source sequence ${frame.sourceSequence} did not follow ${this.lastSequence}`,
      );
    }
    if (this.lastPtsUs !== null && frame.nativePtsUs <= this.lastPtsUs) {
      throw new RecordingFrameRingError(
        frame.nativePtsUs === this.lastPtsUs ? "artifact_pts_duplicate" : "artifact_pts_gap",
        `native PTS ${frame.nativePtsUs} did not increase after ${this.lastPtsUs}`,
      );
    }

    const slot = this.writeIndex;
    if (Atomics.load(this.states, slot) !== 0) {
      throw new RecordingFrameRingError(
        "frame_ring_overflow",
        `frame ring slot ${slot} is not free`,
      );
    }
    const offset = slot * this.slotBytes;
    this.bytes.set(frame.pixels, offset);
    const sha256 = createHash("sha256")
      .update(this.bytes.subarray(offset, offset + this.slotBytes))
      .digest("hex");
    this.sequences[slot] = BigInt(frame.sourceSequence);
    this.ptsUs[slot] = BigInt(frame.nativePtsUs);
    this.hashes[slot] = sha256;
    Atomics.store(this.states, slot, 1);

    const entry = {
      frame_index: this.committed,
      source_sequence: frame.sourceSequence,
      native_pts_us: frame.nativePtsUs,
      sha256,
    };
    this.committed += 1;
    this.queued += 1;
    this.lastSequence = frame.sourceSequence;
    this.lastPtsUs = frame.nativePtsUs;
    this.writeIndex = (slot + 1) % this.capacity;
    return entry;
  }

  take(): RecordingFrameLease | null {
    if (this.queued === 0) return null;
    const slot = this.readIndex;
    if (Atomics.load(this.states, slot) !== 1) return null;
    Atomics.store(this.states, slot, 2);
    const offset = slot * this.slotBytes;
    const pixels = this.bytes.subarray(offset, offset + this.slotBytes);
    const sha256 = this.hashes[slot];
    if (!sha256) {
      Atomics.store(this.states, slot, 1);
      throw new RecordingFrameRingError("contract_mismatch", `frame ring slot ${slot} has no hash`);
    }
    let released = false;
    return {
      frame_index: this.committed - this.queued,
      source_sequence: Number(this.sequences[slot]),
      native_pts_us: Number(this.ptsUs[slot]),
      sha256,
      pixels,
      release: () => {
        if (released) return;
        released = true;
        this.hashes[slot] = null;
        Atomics.store(this.states, slot, 0);
        this.queued -= 1;
        this.readIndex = (slot + 1) % this.capacity;
      },
    };
  }
}

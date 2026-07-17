export interface RecordingFrameRate {
  fpsNum: number;
  fpsDen: number;
}

export interface RecordingFrameLandmark {
  frameIndex: number;
  ptsUs: number;
}

export type RecordingMediaClockState = "running" | "paused" | "frozen";

export interface RecordingMediaClockSnapshot extends RecordingFrameRate {
  clock: "encoded_video_pts";
  unit: "us";
  originFrame: 0;
  frameCount: number;
  durationUs: number;
  nextFrameIndex: number;
  nextPtsUs: number;
  state: RecordingMediaClockState;
}

const MICROSECONDS_PER_SECOND = 1_000_000n;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function roundedDivision(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function recordingFramePtsUs(frameIndex: number, frameRate: RecordingFrameRate): number {
  const index = nonNegativeInteger(frameIndex, "frameIndex");
  const fpsNum = positiveInteger(frameRate.fpsNum, "fpsNum");
  const fpsDen = positiveInteger(frameRate.fpsDen, "fpsDen");
  const ptsUs = roundedDivision(
    BigInt(index) * MICROSECONDS_PER_SECOND * BigInt(fpsDen),
    BigInt(fpsNum),
  );
  const result = Number(ptsUs);
  if (!Number.isSafeInteger(result)) {
    throw new Error("frame PTS exceeds the safe integer range");
  }
  return result;
}

export class RecordingMediaClock {
  readonly fpsNum: number;
  readonly fpsDen: number;
  #frameCount = 0;
  #state: RecordingMediaClockState = "running";

  constructor(frameRate: RecordingFrameRate) {
    this.fpsNum = positiveInteger(frameRate.fpsNum, "fpsNum");
    this.fpsDen = positiveInteger(frameRate.fpsDen, "fpsDen");
  }

  commitFrame(acknowledged: boolean): RecordingFrameLandmark | null {
    if (!acknowledged) return null;
    if (this.#state !== "running") {
      throw new Error(`cannot commit a frame while media clock is ${this.#state}`);
    }
    const landmark = this.nextFrame();
    this.#frameCount += 1;
    return landmark;
  }

  nextFrame(): RecordingFrameLandmark {
    return {
      frameIndex: this.#frameCount,
      ptsUs: recordingFramePtsUs(this.#frameCount, this),
    };
  }

  pause(): void {
    if (this.#state === "frozen") return;
    this.#state = "paused";
  }

  resume(): void {
    if (this.#state === "frozen") return;
    this.#state = "running";
  }

  freeze(): RecordingMediaClockSnapshot {
    this.#state = "frozen";
    return this.snapshot();
  }

  snapshot(): RecordingMediaClockSnapshot {
    const next = this.nextFrame();
    return {
      clock: "encoded_video_pts",
      unit: "us",
      fpsNum: this.fpsNum,
      fpsDen: this.fpsDen,
      originFrame: 0,
      frameCount: this.#frameCount,
      durationUs: next.ptsUs,
      nextFrameIndex: next.frameIndex,
      nextPtsUs: next.ptsUs,
      state: this.#state,
    };
  }
}

import {
  type SourceTimelineMap,
  sourcePtsUsToTimelineMs,
  timelineMsToSourcePtsUs,
} from "../state/source-timeline-map";

export interface PresentedMediaState {
  timelineMs: number;
  sourcePtsUs: number;
  mode: "media" | "hold";
  generation: number;
}

export class PresentedMediaClock {
  private generation = 0;
  private awaitingPresentedFrame = false;
  private state: PresentedMediaState | null = null;

  constructor(private readonly map: SourceTimelineMap) {}

  beginDiscontinuity(): number {
    this.generation += 1;
    this.awaitingPresentedFrame = true;
    return this.generation;
  }

  commitPresentedFrame(
    sourcePtsUs: number,
    generation = this.generation,
  ): PresentedMediaState | null {
    if (generation !== this.generation) return null;
    const timelineMs = sourcePtsUsToTimelineMs(this.map, sourcePtsUs);
    if (timelineMs == null) return null;
    this.awaitingPresentedFrame = false;
    this.state = { timelineMs, sourcePtsUs, mode: "media", generation };
    return this.state;
  }

  commitHold(timelineMs: number): PresentedMediaState | null {
    if (this.awaitingPresentedFrame) return null;
    const sourcePtsUs = timelineMsToSourcePtsUs(this.map, timelineMs);
    if (sourcePtsUs == null) return null;
    this.state = { timelineMs, sourcePtsUs, mode: "hold", generation: this.generation };
    return this.state;
  }

  snapshot(): PresentedMediaState | null {
    return this.state ? { ...this.state } : null;
  }
}

export function serializePresentedMediaState(state: PresentedMediaState | null): string {
  return JSON.stringify(
    state
      ? {
          generation: state.generation,
          mode: state.mode,
          source_pts_us: state.sourcePtsUs,
          timeline_ms: state.timelineMs,
        }
      : null,
  );
}

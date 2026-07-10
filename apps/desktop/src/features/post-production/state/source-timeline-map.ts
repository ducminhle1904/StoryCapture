export type SourceTimelineSegment =
  | {
      kind: "media";
      sourceStartUs: number;
      sourceEndUs: number;
      timelineStartMs: number;
      timelineEndMs: number;
    }
  | {
      kind: "hold";
      sourcePtsUs: number;
      timelineStartMs: number;
      timelineEndMs: number;
      reason?: "cursor-motion" | "user";
    };

export interface SourceTimelineMap {
  version: 1;
  segments: SourceTimelineSegment[];
}

function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

export function identitySourceTimelineMap(durationMs: number): SourceTimelineMap {
  const safeDuration = Math.max(0, durationMs);
  return {
    version: 1,
    segments: [
      {
        kind: "media",
        sourceStartUs: 0,
        sourceEndUs: Math.round(safeDuration * 1000),
        timelineStartMs: 0,
        timelineEndMs: safeDuration,
      },
    ],
  };
}

export function timelineMsToSourcePtsUs(map: SourceTimelineMap, timelineMs: number): number | null {
  const segment = map.segments.find((candidate) =>
    inRange(timelineMs, candidate.timelineStartMs, candidate.timelineEndMs),
  );
  if (!segment) return null;
  if (segment.kind === "hold") return segment.sourcePtsUs;
  const timelineSpan = segment.timelineEndMs - segment.timelineStartMs;
  if (timelineSpan <= 0) return segment.sourceStartUs;
  const progress = (timelineMs - segment.timelineStartMs) / timelineSpan;
  return Math.round(
    segment.sourceStartUs + progress * (segment.sourceEndUs - segment.sourceStartUs),
  );
}

export function sourcePtsUsToTimelineMs(
  map: SourceTimelineMap,
  sourcePtsUs: number,
): number | null {
  for (const segment of map.segments) {
    if (segment.kind === "hold") {
      if (segment.sourcePtsUs === sourcePtsUs) return segment.timelineStartMs;
      continue;
    }
    if (!inRange(sourcePtsUs, segment.sourceStartUs, segment.sourceEndUs)) continue;
    const sourceSpan = segment.sourceEndUs - segment.sourceStartUs;
    if (sourceSpan <= 0) return segment.timelineStartMs;
    const progress = (sourcePtsUs - segment.sourceStartUs) / sourceSpan;
    return segment.timelineStartMs + progress * (segment.timelineEndMs - segment.timelineStartMs);
  }
  return null;
}

export function isIdentitySourceTimelineMap(map: SourceTimelineMap): boolean {
  return (
    map.segments.length === 1 &&
    map.segments[0]?.kind === "media" &&
    map.segments[0].sourceStartUs === 0 &&
    map.segments[0].timelineStartMs === 0 &&
    map.segments[0].sourceEndUs === Math.round(map.segments[0].timelineEndMs * 1000)
  );
}

export function insertSourceHolds(
  map: SourceTimelineMap,
  holds: ReadonlyArray<{ sourcePtsUs: number; durationUs: number }>,
): SourceTimelineMap {
  let segments = map.segments.map((segment) => ({ ...segment }));
  for (const hold of [...holds].sort((a, b) => a.sourcePtsUs - b.sourcePtsUs)) {
    if (hold.durationUs <= 0) continue;
    const index = segments.findIndex(
      (segment) =>
        segment.kind === "media" &&
        hold.sourcePtsUs >= segment.sourceStartUs &&
        hold.sourcePtsUs <= segment.sourceEndUs,
    );
    const segment = segments[index];
    if (!segment || segment.kind !== "media") continue;
    const sourceSpan = segment.sourceEndUs - segment.sourceStartUs;
    const progress = sourceSpan <= 0 ? 0 : (hold.sourcePtsUs - segment.sourceStartUs) / sourceSpan;
    const holdStartMs =
      segment.timelineStartMs + progress * (segment.timelineEndMs - segment.timelineStartMs);
    const holdDurationMs = hold.durationUs / 1000;
    const before: SourceTimelineSegment[] =
      hold.sourcePtsUs > segment.sourceStartUs
        ? [
            {
              kind: "media",
              sourceStartUs: segment.sourceStartUs,
              sourceEndUs: hold.sourcePtsUs,
              timelineStartMs: segment.timelineStartMs,
              timelineEndMs: holdStartMs,
            },
          ]
        : [];
    const after: SourceTimelineSegment[] =
      hold.sourcePtsUs < segment.sourceEndUs
        ? [
            {
              kind: "media",
              sourceStartUs: hold.sourcePtsUs,
              sourceEndUs: segment.sourceEndUs,
              timelineStartMs: holdStartMs + holdDurationMs,
              timelineEndMs: segment.timelineEndMs + holdDurationMs,
            },
          ]
        : [];
    const shiftedTail = segments.slice(index + 1).map((tail) => ({
      ...tail,
      timelineStartMs: tail.timelineStartMs + holdDurationMs,
      timelineEndMs: tail.timelineEndMs + holdDurationMs,
    }));
    segments = [
      ...segments.slice(0, index),
      ...before,
      {
        kind: "hold",
        sourcePtsUs: hold.sourcePtsUs,
        timelineStartMs: holdStartMs,
        timelineEndMs: holdStartMs + holdDurationMs,
        reason: "cursor-motion",
      },
      ...after,
      ...shiftedTail,
    ];
  }
  return { version: 1, segments };
}

export function removeSourceHolds(
  map: SourceTimelineMap,
  reason: NonNullable<Extract<SourceTimelineSegment, { kind: "hold" }>["reason"]>,
): SourceTimelineMap {
  let removedMs = 0;
  const segments: SourceTimelineSegment[] = [];
  for (const segment of map.segments) {
    if (segment.kind === "hold" && segment.reason === reason) {
      removedMs += segment.timelineEndMs - segment.timelineStartMs;
      continue;
    }
    segments.push({
      ...segment,
      timelineStartMs: segment.timelineStartMs - removedMs,
      timelineEndMs: segment.timelineEndMs - removedMs,
    });
  }
  return { version: 1, segments };
}

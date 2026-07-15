import { createHash } from "node:crypto";
import type {
  ExportCompositionGraphV4,
  ExportIssue,
  ExportSoundKind,
  ExportSoundNode,
  ExportVideoNode,
} from "@storycapture/shared-types";

type ExportSourceNode = Extract<ExportVideoNode, { type: "source" }>;
type ExportTransitionNode = Extract<ExportVideoNode, { type: "transition" }>;

export type ExportAudioFormat = "mp4" | "webm" | "gif";

export type ExportAudioOutput =
  | { format: "gif" }
  | {
      format: "mp4" | "webm";
      bitrateKbps: number;
      channels: number;
      sampleRateHz: number;
    };

export interface ExportAudioInputRegistration {
  nodeId: string;
  clipId: string;
  kind: "source" | ExportSoundKind;
  path: string;
  label: string;
  inputIndex: number | null;
  streamLabel: string | null;
  available: boolean;
  included: boolean;
  loop: boolean;
  inputDurationMs: number | null;
}

export interface ExportAudioCrossfade {
  transitionId: string;
  fromSourceId: string;
  toSourceId: string;
  startMs: number;
  durationMs: number;
}

export interface ExportAudioDuckingPlan {
  targetReductionDb: -12;
  attackMs: 80;
  releaseMs: 250;
  carriers: Array<"source" | "bgm">;
}

interface ExportAudioPlanBase {
  registry: ExportAudioInputRegistration[];
  inputArgs: string[];
  filterChains: string[];
  filterComplex: string | null;
  mapArgs: string[];
  encoderArgs: string[];
  outputArgs: string[];
  diagnostics: ExportIssue[];
  crossfades: ExportAudioCrossfade[];
  ducking: ExportAudioDuckingPlan | null;
}

export interface MixedExportAudioPlan extends ExportAudioPlanBase {
  kind: "mixed";
  codec: "aac" | "opus";
  mapLabel: "audio_master";
  filterComplex: string;
  durationMs: number;
  channels: number;
  channelLayout: string;
  sampleRateHz: number;
}

export interface SilentExportAudioPlan extends ExportAudioPlanBase {
  kind: "none";
  codec: null;
  mapLabel: null;
}

export interface InvalidExportAudioPlan extends ExportAudioPlanBase {
  kind: "invalid";
  codec: null;
  mapLabel: null;
}

export type ExportAudioPlan = MixedExportAudioPlan | SilentExportAudioPlan | InvalidExportAudioPlan;

export interface BuildExportAudioPlanInput {
  graph: ExportCompositionGraphV4;
  output: ExportAudioOutput;
  /**
   * Probe result keyed by source node id. Every source must be present. A
   * `false` entry deliberately emits silence instead of referencing a missing
   * FFmpeg audio stream.
   */
  sourceAudio: Readonly<Record<string, boolean>>;
  /** The raw-frame video input occupies index 0 in the composited export. */
  firstInputIndex?: number;
}

export const EXPORT_AUDIO_DUCKING = {
  targetReductionDb: -12,
  attackMs: 80,
  releaseMs: 250,
  threshold: 0.063096,
  ratio: 2,
} as const;

export const EXPORT_AUDIO_LIMIT_DBFS = -1 as const;

const LIMIT_LINEAR = 0.891251;
const MAX_AUDIO_CHANNELS = 8;
const MIN_SAMPLE_RATE_HZ = 8_000;
const MAX_SAMPLE_RATE_HZ = 192_000;
const MIN_BITRATE_KBPS = 16;
const MAX_BITRATE_KBPS = 1_024;
const TIME_TOLERANCE_MS = 0.5;

const SOUND_KIND_ORDER: Record<ExportSoundKind, number> = {
  bgm: 0,
  sfx: 1,
  voiceover: 2,
};

interface PlannedSource {
  node: ExportSourceNode;
  registration: ExportAudioInputRegistration;
  effectiveStartMs: number;
  fadeInMs: number | null;
  fadeOut: { startMs: number; durationMs: number } | null;
}

type PlannedSegment =
  | {
      kind: "media";
      sourceStartUs: number;
      sourceEndUs: number;
      durationMs: number;
    }
  | { kind: "silence"; durationMs: number };

function stableLabel(kind: "source" | ExportSoundKind, id: string): string {
  const digest = createHash("sha256").update(`${kind}\0${id}`).digest("hex").slice(0, 16);
  return `${kind === "source" ? "src" : kind}_${digest}`;
}

function issue(
  code: string,
  message: string,
  options: { severity?: ExportIssue["severity"]; clipId?: string; property?: string } = {},
): ExportIssue {
  return {
    id: options.clipId ? `${code}:${options.clipId}` : code,
    code,
    severity: options.severity ?? "error",
    message,
    clip_id: options.clipId,
    property: options.property ?? "audio",
  };
}

function compareSource(left: ExportSourceNode, right: ExportSourceNode): number {
  return (
    left.timeline_start_ms - right.timeline_start_ms ||
    left.clip_id.localeCompare(right.clip_id) ||
    left.id.localeCompare(right.id)
  );
}

function compareSound(left: ExportSoundNode, right: ExportSoundNode): number {
  return (
    left.t_start_ms - right.t_start_ms ||
    SOUND_KIND_ORDER[left.kind] - SOUND_KIND_ORDER[right.kind] ||
    left.clip_id.localeCompare(right.clip_id) ||
    left.id.localeCompare(right.id)
  );
}

function compareTransition(left: ExportTransitionNode, right: ExportTransitionNode): number {
  return left.offset_ms - right.offset_ms || left.id.localeCompare(right.id);
}

function sourceNodes(graph: ExportCompositionGraphV4): ExportSourceNode[] {
  return graph.video
    .filter((node): node is ExportSourceNode => node.type === "source")
    .sort(compareSource);
}

function transitionNodes(graph: ExportCompositionGraphV4): ExportTransitionNode[] {
  return graph.video
    .filter((node): node is ExportTransitionNode => node.type === "transition")
    .sort(compareTransition);
}

function soundNodes(graph: ExportCompositionGraphV4): ExportSoundNode[] {
  return [...graph.audio].sort(compareSound);
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validateOutput(output: ExportAudioOutput): ExportIssue[] {
  if (output.format === "gif") return [];
  const diagnostics: ExportIssue[] = [];
  if (
    !Number.isInteger(output.bitrateKbps) ||
    output.bitrateKbps < MIN_BITRATE_KBPS ||
    output.bitrateKbps > MAX_BITRATE_KBPS
  ) {
    diagnostics.push(
      issue(
        "export.audio-bitrate-invalid",
        `Audio bitrate must be an integer between ${MIN_BITRATE_KBPS} and ${MAX_BITRATE_KBPS} kbps.`,
      ),
    );
  }
  if (
    !Number.isInteger(output.channels) ||
    output.channels < 1 ||
    output.channels > MAX_AUDIO_CHANNELS
  ) {
    diagnostics.push(
      issue(
        "export.audio-channels-invalid",
        `Audio channel count must be an integer between 1 and ${MAX_AUDIO_CHANNELS}.`,
      ),
    );
  }
  if (
    !Number.isInteger(output.sampleRateHz) ||
    output.sampleRateHz < MIN_SAMPLE_RATE_HZ ||
    output.sampleRateHz > MAX_SAMPLE_RATE_HZ
  ) {
    diagnostics.push(
      issue(
        "export.audio-sample-rate-invalid",
        `Audio sample rate must be an integer between ${MIN_SAMPLE_RATE_HZ} and ${MAX_SAMPLE_RATE_HZ} Hz.`,
      ),
    );
  }
  return diagnostics;
}

function validateGraph(
  graph: ExportCompositionGraphV4,
  sources: readonly ExportSourceNode[],
  sounds: readonly ExportSoundNode[],
  transitions: readonly ExportTransitionNode[],
  sourceAudio: Readonly<Record<string, boolean>>,
): ExportIssue[] {
  const diagnostics: ExportIssue[] = [];
  if (!Number.isFinite(graph.duration_ms) || graph.duration_ms <= 0) {
    diagnostics.push(
      issue("export.audio-duration-invalid", "Composition duration must be greater than zero."),
    );
  }

  const ids = new Set<string>();
  for (const node of [...sources, ...sounds]) {
    if (ids.has(node.id)) {
      diagnostics.push(
        issue("export.audio-node-id-duplicate", `Audio node id ${node.id} is not unique.`, {
          clipId: node.clip_id,
        }),
      );
    }
    ids.add(node.id);
  }

  for (const source of sources) {
    if (!Object.hasOwn(sourceAudio, source.id)) {
      diagnostics.push(
        issue(
          "export.audio-source-state-missing",
          `Source ${source.clip_id} has no audio-stream probe result.`,
          { clipId: source.clip_id },
        ),
      );
    }
    if (
      !source.path ||
      !finiteNonNegative(source.timeline_start_ms) ||
      !Number.isFinite(source.duration_ms) ||
      source.duration_ms <= 0
    ) {
      diagnostics.push(
        issue(
          "export.audio-source-invalid",
          `Source ${source.clip_id} requires a path, non-negative start, and positive duration.`,
          { clipId: source.clip_id },
        ),
      );
    }
    const segmentError = validateSourceSegments(source);
    if (segmentError) {
      diagnostics.push(
        issue("export.audio-source-map-invalid", segmentError, { clipId: source.clip_id }),
      );
    }
  }

  for (const sound of sounds) {
    if (
      !sound.path ||
      !finiteNonNegative(sound.t_start_ms) ||
      !Number.isFinite(sound.duration_ms) ||
      sound.duration_ms <= 0 ||
      !finiteNonNegative(sound.gain)
    ) {
      diagnostics.push(
        issue(
          "export.audio-sound-invalid",
          `Sound ${sound.clip_id} requires a path, non-negative start/gain, and positive duration.`,
          { clipId: sound.clip_id },
        ),
      );
    }
    if (sound.t_start_ms + sound.duration_ms > graph.duration_ms + TIME_TOLERANCE_MS) {
      diagnostics.push(
        issue(
          "export.audio-sound-outside-composition",
          `Sound ${sound.clip_id} ends after the composition duration.`,
          { clipId: sound.clip_id },
        ),
      );
    }
  }

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const incomingTransitionBySource = new Map(
    transitions.map((transition) => [transition.to_source_id, transition]),
  );
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const transition of transitions) {
    const from = sourceById.get(transition.from_source_id);
    const to = sourceById.get(transition.to_source_id);
    if (!from || !to) {
      diagnostics.push(
        issue(
          "export.audio-transition-source-missing",
          `Transition ${transition.id} references a source that is not present.`,
        ),
      );
      continue;
    }
    if (
      !Number.isFinite(transition.duration_ms) ||
      transition.duration_ms <= 0 ||
      !finiteNonNegative(transition.offset_ms) ||
      transition.duration_ms > from.duration_ms + TIME_TOLERANCE_MS ||
      transition.duration_ms > to.duration_ms + TIME_TOLERANCE_MS
    ) {
      diagnostics.push(
        issue(
          "export.audio-transition-invalid",
          `Transition ${transition.id} has invalid timing for its source pair.`,
        ),
      );
    }
    const fromStartMs =
      incomingTransitionBySource.get(from.id)?.offset_ms ?? from.timeline_start_ms;
    const fadeOutStartMs = transition.offset_ms - fromStartMs;
    if (
      fadeOutStartMs < -TIME_TOLERANCE_MS ||
      fadeOutStartMs + transition.duration_ms > from.duration_ms + TIME_TOLERANCE_MS ||
      transition.offset_ms + transition.duration_ms > graph.duration_ms + TIME_TOLERANCE_MS
    ) {
      diagnostics.push(
        issue(
          "export.audio-transition-outside-source",
          `Transition ${transition.id} falls outside its source or composition timing.`,
        ),
      );
    }
    if (incoming.has(to.id) || outgoing.has(from.id)) {
      diagnostics.push(
        issue(
          "export.audio-transition-ambiguous",
          `Source transition graph has more than one incoming or outgoing edge for ${transition.id}.`,
        ),
      );
    }
    incoming.add(to.id);
    outgoing.add(from.id);
  }
  return diagnostics;
}

function validateSourceSegments(source: ExportSourceNode): string | null {
  const map = source.source_time_map;
  if (!map) return null;
  if (map.version !== 1 || map.segments.length === 0) {
    return `Source ${source.clip_id} has an empty or unsupported source time map.`;
  }
  const segments = [...map.segments].sort(
    (left, right) =>
      left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs,
  );
  let cursorMs = 0;
  for (const segment of segments) {
    if (
      !finiteNonNegative(segment.timelineStartMs) ||
      !Number.isFinite(segment.timelineEndMs) ||
      segment.timelineEndMs <= segment.timelineStartMs
    ) {
      return `Source ${source.clip_id} has a source time-map segment with invalid timeline bounds.`;
    }
    if (segment.timelineStartMs < cursorMs - TIME_TOLERANCE_MS) {
      return `Source ${source.clip_id} has overlapping source time-map segments.`;
    }
    if (segment.timelineEndMs > source.duration_ms + TIME_TOLERANCE_MS) {
      return `Source ${source.clip_id} has a source time-map segment beyond its clip duration.`;
    }
    if (segment.kind === "media") {
      if (
        !finiteNonNegative(segment.sourceStartUs) ||
        !Number.isFinite(segment.sourceEndUs) ||
        segment.sourceEndUs <= segment.sourceStartUs
      ) {
        return `Source ${source.clip_id} has a media segment with invalid source bounds.`;
      }
    } else if (!finiteNonNegative(segment.sourcePtsUs)) {
      return `Source ${source.clip_id} has a hold segment with an invalid source PTS.`;
    }
    cursorMs = segment.timelineEndMs;
  }
  return null;
}

function registryFor(
  sources: readonly ExportSourceNode[],
  sounds: readonly ExportSoundNode[],
  sourceAudio: Readonly<Record<string, boolean>>,
  firstInputIndex: number,
  includeInputs: boolean,
): ExportAudioInputRegistration[] {
  let nextInputIndex = firstInputIndex;
  const registrations: ExportAudioInputRegistration[] = [];
  for (const source of sources) {
    const available = sourceAudio[source.id] === true;
    const needsMedia =
      source.source_time_map === undefined ||
      source.source_time_map.segments.some((segment) => segment.kind === "media");
    const included = includeInputs && available && needsMedia;
    const inputIndex = included ? nextInputIndex++ : null;
    registrations.push({
      nodeId: source.id,
      clipId: source.clip_id,
      kind: "source",
      path: source.path,
      label: stableLabel("source", source.id),
      inputIndex,
      streamLabel: inputIndex === null ? null : `${inputIndex}:a:0`,
      available,
      included,
      loop: false,
      inputDurationMs: null,
    });
  }
  for (const sound of sounds) {
    const included = includeInputs;
    const inputIndex = included ? nextInputIndex++ : null;
    registrations.push({
      nodeId: sound.id,
      clipId: sound.clip_id,
      kind: sound.kind,
      path: sound.path,
      label: stableLabel(sound.kind, sound.id),
      inputIndex,
      streamLabel: inputIndex === null ? null : `${inputIndex}:a:0`,
      available: true,
      included,
      loop: sound.kind === "bgm" && included,
      inputDurationMs: sound.duration_ms,
    });
  }
  return registrations;
}

function inputArgs(registry: readonly ExportAudioInputRegistration[]): string[] {
  const args: string[] = [];
  for (const entry of registry) {
    if (!entry.included) continue;
    if (entry.inputDurationMs !== null) {
      args.push("-t", secondsFromMs(entry.inputDurationMs));
    }
    args.push("-i", entry.path);
  }
  return args;
}

function secondsFromMs(value: number): string {
  return (value / 1_000).toFixed(6);
}

function secondsFromUs(value: number): string {
  return (value / 1_000_000).toFixed(6);
}

function compactNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function channelLayout(channels: number): string {
  switch (channels) {
    case 1:
      return "mono";
    case 2:
      return "stereo";
    case 3:
      return "2.1";
    case 4:
      return "quad";
    case 5:
      return "5.0";
    case 6:
      return "5.1";
    case 7:
      return "6.1";
    default:
      return "7.1";
  }
}

function normalizedInputFilter(
  streamLabel: string,
  outputLabel: string,
  sampleRateHz: number,
  layout: string,
): string {
  return `[${streamLabel}]asetpts=PTS-STARTPTS,aresample=${sampleRateHz}:async=0:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${sampleRateHz}:channel_layouts=${layout}[${outputLabel}]`;
}

function silenceFilter(
  outputLabel: string,
  durationMs: number,
  sampleRateHz: number,
  layout: string,
): string {
  return `anullsrc=r=${sampleRateHz}:cl=${layout},atrim=duration=${secondsFromMs(durationMs)},asetpts=PTS-STARTPTS[${outputLabel}]`;
}

function tempoFilters(tempo: number): string[] {
  if (!Number.isFinite(tempo) || tempo <= 0) return [];
  const factors: number[] = [];
  let remaining = tempo;
  while (remaining > 2 + 1e-9) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-9) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-6) factors.push(remaining);
  return factors.map((factor) => `atempo=${compactNumber(factor)}`);
}

function plannedSegments(source: ExportSourceNode): PlannedSegment[] {
  const map = source.source_time_map;
  if (!map) {
    return [
      {
        kind: "media",
        sourceStartUs: 0,
        sourceEndUs: Math.round(source.duration_ms * 1_000),
        durationMs: source.duration_ms,
      },
    ];
  }

  const segments = [...map.segments].sort(
    (left, right) =>
      left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs,
  );
  const planned: PlannedSegment[] = [];
  let cursorMs = 0;
  for (const segment of segments) {
    if (segment.timelineStartMs > cursorMs + TIME_TOLERANCE_MS) {
      planned.push({ kind: "silence", durationMs: segment.timelineStartMs - cursorMs });
    }
    const durationMs = segment.timelineEndMs - segment.timelineStartMs;
    if (segment.kind === "media") {
      planned.push({
        kind: "media",
        sourceStartUs: segment.sourceStartUs,
        sourceEndUs: segment.sourceEndUs,
        durationMs,
      });
    } else {
      planned.push({ kind: "silence", durationMs });
    }
    cursorMs = segment.timelineEndMs;
  }
  if (cursorMs < source.duration_ms - TIME_TOLERANCE_MS) {
    planned.push({ kind: "silence", durationMs: source.duration_ms - cursorMs });
  }
  return planned;
}

function sourceContentFilters(
  source: ExportSourceNode,
  registration: ExportAudioInputRegistration,
  sampleRateHz: number,
  layout: string,
): { filters: string[]; outputLabel: string } {
  const outputLabel = `${registration.label}_content`;
  if (!registration.available || registration.streamLabel === null) {
    return {
      filters: [silenceFilter(outputLabel, source.duration_ms, sampleRateHz, layout)],
      outputLabel,
    };
  }

  const filters: string[] = [];
  const segments = plannedSegments(source);
  const mediaCount = segments.filter((segment) => segment.kind === "media").length;
  const normalizedLabel = `${registration.label}_input`;
  const mediaLabels: string[] = [];
  if (mediaCount > 0) {
    filters.push(
      normalizedInputFilter(registration.streamLabel, normalizedLabel, sampleRateHz, layout),
    );
  }
  if (mediaCount === 1) {
    mediaLabels.push(normalizedLabel);
  } else if (mediaCount > 1) {
    for (let index = 0; index < mediaCount; index += 1) {
      mediaLabels.push(`${registration.label}_media_${index}`);
    }
    filters.push(
      `[${normalizedLabel}]asplit=${mediaCount}${mediaLabels.map((label) => `[${label}]`).join("")}`,
    );
  }

  let mediaIndex = 0;
  const segmentLabels: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const segmentLabel = `${registration.label}_segment_${index}`;
    segmentLabels.push(segmentLabel);
    if (segment.kind === "silence") {
      filters.push(silenceFilter(segmentLabel, segment.durationMs, sampleRateHz, layout));
      continue;
    }
    const sourceDurationMs = (segment.sourceEndUs - segment.sourceStartUs) / 1_000;
    const tempo = sourceDurationMs / segment.durationMs;
    const chain = [
      `atrim=start=${secondsFromUs(segment.sourceStartUs)}:end=${secondsFromUs(segment.sourceEndUs)}`,
      "asetpts=PTS-STARTPTS",
      ...tempoFilters(tempo),
      `atrim=duration=${secondsFromMs(segment.durationMs)}`,
      "asetpts=PTS-STARTPTS",
    ];
    filters.push(`[${mediaLabels[mediaIndex++]}]${chain.join(",")}[${segmentLabel}]`);
  }

  const exactDuration = `apad=pad_dur=${secondsFromMs(source.duration_ms)},atrim=duration=${secondsFromMs(source.duration_ms)}`;
  if (segmentLabels.length === 1) {
    filters.push(`[${segmentLabels[0]}]${exactDuration}[${outputLabel}]`);
  } else {
    filters.push(
      `${segmentLabels.map((label) => `[${label}]`).join("")}concat=n=${segmentLabels.length}:v=0:a=1,${exactDuration}[${outputLabel}]`,
    );
  }
  return { filters, outputLabel };
}

function planSources(
  sources: readonly ExportSourceNode[],
  transitions: readonly ExportTransitionNode[],
  registry: readonly ExportAudioInputRegistration[],
): { sources: PlannedSource[]; crossfades: ExportAudioCrossfade[] } {
  const registrationById = new Map(registry.map((entry) => [entry.nodeId, entry]));
  const incoming = new Map(transitions.map((transition) => [transition.to_source_id, transition]));
  const outgoing = new Map(
    transitions.map((transition) => [transition.from_source_id, transition]),
  );
  return {
    sources: sources.map((node) => {
      const incomingTransition = incoming.get(node.id);
      const outgoingTransition = outgoing.get(node.id);
      const effectiveStartMs = incomingTransition?.offset_ms ?? node.timeline_start_ms;
      return {
        node,
        registration: registrationById.get(node.id) as ExportAudioInputRegistration,
        effectiveStartMs,
        fadeInMs: incomingTransition?.duration_ms ?? null,
        fadeOut: outgoingTransition
          ? {
              startMs: outgoingTransition.offset_ms - effectiveStartMs,
              durationMs: outgoingTransition.duration_ms,
            }
          : null,
      };
    }),
    crossfades: transitions.map((transition) => ({
      transitionId: transition.id,
      fromSourceId: transition.from_source_id,
      toSourceId: transition.to_source_id,
      startMs: transition.offset_ms,
      durationMs: transition.duration_ms,
    })),
  };
}

function sourceTrackFilters(
  source: PlannedSource,
  graphDurationMs: number,
  sampleRateHz: number,
  layout: string,
): { filters: string[]; outputLabel: string } {
  const content = sourceContentFilters(source.node, source.registration, sampleRateHz, layout);
  const outputLabel = `${source.registration.label}_track`;
  const chain: string[] = [];
  if (source.fadeInMs !== null) {
    chain.push(`afade=t=in:st=0:d=${secondsFromMs(source.fadeInMs)}:curve=tri`);
  }
  if (source.fadeOut) {
    chain.push(
      `afade=t=out:st=${secondsFromMs(source.fadeOut.startMs)}:d=${secondsFromMs(source.fadeOut.durationMs)}:curve=tri`,
    );
  }
  if (source.effectiveStartMs > 0) {
    chain.push(`adelay=delays=${Math.round(source.effectiveStartMs)}:all=1`);
  }
  chain.push(`atrim=duration=${secondsFromMs(graphDurationMs)}`);
  return {
    filters: [...content.filters, `[${content.outputLabel}]${chain.join(",")}[${outputLabel}]`],
    outputLabel,
  };
}

function soundTrackFilter(
  sound: ExportSoundNode,
  registration: ExportAudioInputRegistration,
  graphDurationMs: number,
  sampleRateHz: number,
  layout: string,
): { filter: string; outputLabel: string } {
  const outputLabel = `${registration.label}_track`;
  const filters = [
    "asetpts=PTS-STARTPTS",
    `aresample=${sampleRateHz}:async=0:first_pts=0`,
    `aformat=sample_fmts=fltp:sample_rates=${sampleRateHz}:channel_layouts=${layout}`,
  ];
  if (sound.kind === "bgm") filters.push("aloop=loop=-1:size=2147483647");
  filters.push(
    `atrim=duration=${secondsFromMs(sound.duration_ms)}`,
    "asetpts=PTS-STARTPTS",
    `volume=${compactNumber(sound.gain)}`,
  );
  if (sound.t_start_ms > 0) {
    filters.push(`adelay=delays=${Math.round(sound.t_start_ms)}:all=1`);
  }
  filters.push(`atrim=duration=${secondsFromMs(graphDurationMs)}`);
  return {
    filter: `[${registration.streamLabel}]${filters.join(",")}[${outputLabel}]`,
    outputLabel,
  };
}

function busFilter(
  inputLabels: readonly string[],
  outputLabel: string,
  durationMs: number,
): string {
  const exactDuration = `apad=pad_dur=${secondsFromMs(durationMs)},atrim=duration=${secondsFromMs(durationMs)}`;
  if (inputLabels.length === 1) {
    return `[${inputLabels[0]}]${exactDuration}[${outputLabel}]`;
  }
  return `${inputLabels.map((label) => `[${label}]`).join("")}amix=inputs=${inputLabels.length}:duration=longest:normalize=0:dropout_transition=0,${exactDuration}[${outputLabel}]`;
}

function sidechainFilter(carrier: string, sidechain: string, outputLabel: string): string {
  return `[${carrier}][${sidechain}]sidechaincompress=threshold=${EXPORT_AUDIO_DUCKING.threshold}:ratio=${EXPORT_AUDIO_DUCKING.ratio}:attack=${EXPORT_AUDIO_DUCKING.attackMs}:release=${EXPORT_AUDIO_DUCKING.releaseMs}[${outputLabel}]`;
}

function emptyPlan(
  kind: "none" | "invalid",
  registry: ExportAudioInputRegistration[],
  diagnostics: ExportIssue[],
): SilentExportAudioPlan | InvalidExportAudioPlan {
  return {
    kind,
    codec: null,
    mapLabel: null,
    registry,
    inputArgs: [],
    filterChains: [],
    filterComplex: null,
    mapArgs: kind === "none" ? ["-an"] : [],
    encoderArgs: [],
    outputArgs: [],
    diagnostics,
    crossfades: [],
    ducking: null,
  };
}

export function buildExportAudioPlan(input: BuildExportAudioPlanInput): ExportAudioPlan {
  const sources = sourceNodes(input.graph);
  const sounds = soundNodes(input.graph);
  const transitions = transitionNodes(input.graph);
  const firstInputIndex = input.firstInputIndex ?? 1;
  const baseRegistry = registryFor(
    sources,
    sounds,
    input.sourceAudio,
    firstInputIndex,
    input.output.format !== "gif",
  );

  if (input.output.format === "gif") {
    return emptyPlan("none", baseRegistry, [
      issue(
        "export.audio-omitted-for-gif",
        "GIF export keeps the composition duration but does not contain audio.",
        { severity: "info" },
      ),
    ]);
  }

  const diagnostics = [
    ...validateOutput(input.output),
    ...validateGraph(input.graph, sources, sounds, transitions, input.sourceAudio),
  ].sort((left, right) => left.id.localeCompare(right.id));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return emptyPlan(
      "invalid",
      registryFor(sources, sounds, input.sourceAudio, firstInputIndex, false),
      diagnostics,
    );
  }

  const sampleRateHz = input.output.sampleRateHz;
  const layout = channelLayout(input.output.channels);
  const filters: string[] = [];
  const planned = planSources(sources, transitions, baseRegistry);
  const sourceTrackLabels: string[] = [];
  for (const source of planned.sources) {
    const track = sourceTrackFilters(source, input.graph.duration_ms, sampleRateHz, layout);
    filters.push(...track.filters);
    sourceTrackLabels.push(track.outputLabel);
  }

  let sourceBus: string | null = null;
  if (sourceTrackLabels.length > 0) {
    sourceBus = "source_bus";
    filters.push(busFilter(sourceTrackLabels, sourceBus, input.graph.duration_ms));
  }

  const registrationsById = new Map(baseRegistry.map((entry) => [entry.nodeId, entry]));
  const soundLabels: Record<ExportSoundKind, string[]> = { bgm: [], sfx: [], voiceover: [] };
  for (const sound of sounds) {
    const registration = registrationsById.get(sound.id) as ExportAudioInputRegistration;
    const track = soundTrackFilter(
      sound,
      registration,
      input.graph.duration_ms,
      sampleRateHz,
      layout,
    );
    filters.push(track.filter);
    soundLabels[sound.kind].push(track.outputLabel);
  }

  const buses: Partial<Record<ExportSoundKind, string>> = {};
  for (const kind of ["bgm", "sfx", "voiceover"] as const) {
    if (soundLabels[kind].length === 0) continue;
    const label = `${kind}_bus`;
    filters.push(busFilter(soundLabels[kind], label, input.graph.duration_ms));
    buses[kind] = label;
  }

  const duckingCarriers: Array<"source" | "bgm"> = [];
  let finalSourceBus = sourceBus;
  let finalBgmBus = buses.bgm ?? null;
  let finalVoiceoverBus = buses.voiceover ?? null;
  if (finalVoiceoverBus) {
    const carriers: Array<{ kind: "source" | "bgm"; label: string }> = [];
    if (finalSourceBus) carriers.push({ kind: "source", label: finalSourceBus });
    if (finalBgmBus) carriers.push({ kind: "bgm", label: finalBgmBus });
    if (carriers.length > 0) {
      const finalLabel = "voiceover_final";
      const splitLabels = [
        finalLabel,
        ...carriers.map((carrier) => `voiceover_sc_${carrier.kind}`),
      ];
      filters.push(
        `[${finalVoiceoverBus}]asplit=${splitLabels.length}${splitLabels.map((label) => `[${label}]`).join("")}`,
      );
      finalVoiceoverBus = finalLabel;
      for (const carrier of carriers) {
        const outputLabel = `${carrier.kind}_ducked`;
        filters.push(sidechainFilter(carrier.label, `voiceover_sc_${carrier.kind}`, outputLabel));
        if (carrier.kind === "source") finalSourceBus = outputLabel;
        else finalBgmBus = outputLabel;
        duckingCarriers.push(carrier.kind);
      }
    }
  }

  const masterSilence = "master_silence";
  filters.push(silenceFilter(masterSilence, input.graph.duration_ms, sampleRateHz, layout));
  const masterInputs = [
    masterSilence,
    finalSourceBus,
    finalBgmBus,
    buses.sfx ?? null,
    finalVoiceoverBus,
  ].filter((label): label is string => label !== null);
  filters.push(
    `${masterInputs.map((label) => `[${label}]`).join("")}amix=inputs=${masterInputs.length}:duration=first:normalize=0:dropout_transition=0,aresample=${sampleRateHz}:async=0:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${sampleRateHz}:channel_layouts=${layout},alimiter=limit=${LIMIT_LINEAR}:attack=5:release=50:level=disabled,atrim=duration=${secondsFromMs(input.graph.duration_ms)}[audio_master]`,
  );

  const codec = input.output.format === "webm" ? "opus" : "aac";
  return {
    kind: "mixed",
    codec,
    mapLabel: "audio_master",
    durationMs: input.graph.duration_ms,
    channels: input.output.channels,
    channelLayout: layout,
    sampleRateHz,
    registry: baseRegistry,
    inputArgs: inputArgs(baseRegistry),
    filterChains: filters,
    filterComplex: filters.join(";"),
    mapArgs: ["-map", "[audio_master]"],
    encoderArgs: [
      "-c:a",
      codec === "opus" ? "libopus" : "aac",
      "-b:a",
      `${input.output.bitrateKbps}k`,
      "-ac",
      String(input.output.channels),
      "-ar",
      String(sampleRateHz),
    ],
    outputArgs: ["-t", secondsFromMs(input.graph.duration_ms)],
    diagnostics,
    crossfades: planned.crossfades,
    ducking:
      duckingCarriers.length > 0
        ? {
            targetReductionDb: EXPORT_AUDIO_DUCKING.targetReductionDb,
            attackMs: EXPORT_AUDIO_DUCKING.attackMs,
            releaseMs: EXPORT_AUDIO_DUCKING.releaseMs,
            carriers: duckingCarriers,
          }
        : null,
  };
}

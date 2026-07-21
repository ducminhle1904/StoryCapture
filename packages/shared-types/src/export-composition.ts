/**
 * JSON-safe post-production export contract shared by the renderer and the
 * Electron host. This contract is handwritten on purpose: the generated
 * effects surface uses bigint timestamps and is not safe to stringify.
 */

import type { ExportRecordingSource } from "./recording-v2";

export const EXPORT_COMPOSITION_SCHEMA_VERSION = 5 as const;
export const EXPORT_FOREGROUND_SCALE_MIN = 0.7;
export const EXPORT_FOREGROUND_SCALE_MAX = 1;
export const EXPORT_FOREGROUND_SCALE_DEFAULT = 0.85;

export function isValidExportForegroundScale(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= EXPORT_FOREGROUND_SCALE_MIN &&
    value <= EXPORT_FOREGROUND_SCALE_MAX
  );
}

export interface ExportVec2 {
  x: number;
  y: number;
}

export interface ExportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExportRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type ExportSourceTimelineSegment =
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

export interface ExportSourceTimelineMap {
  version: 1;
  segments: ExportSourceTimelineSegment[];
}

export type ExportZoomTarget =
  | { kind: "cursor" }
  | { kind: "fixed-region"; top_left: ExportVec2; size: ExportVec2 }
  | { kind: "element"; selector: string };

export type ExportCursorSkin = "mac-default" | "win-default" | "dark" | "light" | "big-arrow";

export type ExportCursorMotionPreset = "natural" | "snappy" | "cinematic";

export type ExportTransitionKind =
  | "fade"
  | "fade-black"
  | "fade-white"
  | "dissolve"
  | "wipe-left"
  | "wipe-right"
  | "wipe-up"
  | "wipe-down"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "circle-open"
  | "circle-close";

export type ExportEasingKind =
  | "linear"
  | "ease-in-cubic"
  | "ease-out-cubic"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "ease-in-out-cubic"
  | "ease-out-quad";

export interface ExportZoomKeyframe {
  t_ms: number;
  center: ExportVec2;
  scale: number;
  easing: ExportEasingKind;
}

export type ExportBackgroundKind =
  | { kind: "ambient" }
  | { kind: "solid"; color: ExportRgba }
  | { kind: "gradient"; preset_id: string }
  | { kind: "image"; asset_id: string | null; path: string | null };

export interface ExportTrajectoryRef {
  kind: "actions" | "trajectory" | "png-sequence";
  path: string;
  /** Compatibility name consumed by the v3 compositor until the P5 cutover. */
  png_sequence_dir: string;
  fps: number;
  frame_count: number;
}

export interface ExportCursorClickEffect {
  style: "none" | "ring" | "soft-pulse" | "echo" | "press";
  color: "auto" | "white" | "black" | "brand";
  intensity: "subtle" | "normal" | "strong";
}

export type ExportTextFontChoice =
  | { kind: "bundled"; family: string; weight: number; style?: "normal" | "italic" }
  | {
      kind: "system";
      family: string;
      fullName: string;
      postscriptName: string;
      faceStyle: string;
      weight: number;
      style: "normal" | "italic";
    }
  | { kind: "system-default" };

export type ExportTextAnchor =
  | { kind: "screen"; pos: ExportVec2 }
  | { kind: "cursor"; offset: ExportVec2 }
  | {
      kind: "target";
      stepId: string;
      placement: "top" | "right" | "bottom" | "left";
    }
  | { kind: "safe-area"; placement: "top" | "bottom" | "center" };

export interface ExportVoiceoverBinding {
  kind: "story-voiceover";
  stepId: string | null;
  ordinal: number;
}

export interface ExportTextOverlayBinding {
  kind: "story-text-overlay";
  stepId: string | null;
  ordinal: number;
}

export interface ExportTextShadow {
  color: ExportRgba;
  blur_px: number;
  offset_x_px: number;
  offset_y_px: number;
}

export interface ExportTextBoxStyle {
  padding_px: number;
  radius_px: number;
  bg_color: ExportRgba;
  border_color: ExportRgba | null;
  border_width_px: number;
  shadow: ExportTextShadow | null;
}

export type ExportTextAnim = "none" | "fade" | "slide-up" | "scale-in";

export interface ExportTextBox {
  clip_id: string;
  t_start_ms: number;
  t_end_ms: number;
  text: string;
  /** Compatibility position; canonical renderers resolve `anchor` each frame. */
  pos: ExportVec2;
  fallback_pos: ExportVec2;
  anchor: ExportTextAnchor;
  source_binding: ExportTextOverlayBinding | null;
  font: ExportTextFontChoice;
  size_pt: number;
  color: ExportRgba;
  align: "left" | "center" | "right";
  max_width_pct: number;
  line_height: number;
  letter_spacing_px: number;
  text_shadow: ExportTextShadow | null;
  box_style: ExportTextBoxStyle | null;
  anim_in: ExportTextAnim;
  anim_out: Extract<ExportTextAnim, "none" | "fade">;
  anim_duration_ms: number;
}

export interface ExportRippleEvent {
  clip_id: string;
  t_anticipate_ms: number;
  t_impact_ms: number;
  duration_ms: number;
  center: ExportVec2;
  max_radius_px: number;
  bounds?: ExportRect;
  color: ExportRgba;
}

export interface ExportHighlightOverlaySpec {
  clip_id: string;
  t_start_ms: number;
  duration_ms: number;
  shape: "ring" | "spotlight";
  /** Compatibility output-space geometry for the v3 compositor. */
  center: ExportVec2;
  bounds?: ExportRect;
  /** Canonical source-space geometry, transformed at the evaluated frame. */
  source_center: ExportVec2;
  source_bounds?: ExportRect;
  max_radius_px: number;
  padding_px: number;
  radius_px: number;
  stroke_px: number;
  glow_px: number;
  color: ExportRgba;
  opacity: number;
  png_path?: string | null;
  overlay_pos?: ExportVec2 | null;
}

export type ExportVideoNodeBase =
  | {
      type: "source";
      id: string;
      clip_id: string;
      path: string;
      pts_offset_ms: number;
      timeline_start_ms: number;
      duration_ms: number;
      source_width?: number;
      source_height?: number;
      source_time_map?: ExportSourceTimelineMap;
      /** Versioned recording bundle metadata. Missing on legacy compositions. */
      recording_source?: ExportRecordingSource | null;
    }
  | {
      type: "zoom-pan";
      id: string;
      clip_id: string;
      t_start_ms: number;
      duration_ms: number;
      target: ExportZoomTarget;
      keyframes: ExportZoomKeyframe[];
    }
  | {
      type: "cursor-overlay";
      id: string;
      clip_id: string;
      skin: ExportCursorSkin;
      size_scale: number;
      motion_preset: ExportCursorMotionPreset;
      preserve_full_motion: boolean;
      click_effect: ExportCursorClickEffect;
      color_tint: ExportRgba | null;
      t_start_ms: number;
      duration_ms: number;
      source_time_map?: ExportSourceTimelineMap;
      trajectory: ExportTrajectoryRef;
    }
  | { type: "ripple-overlay"; id: string; events: ExportRippleEvent[] }
  | { type: "highlight-overlay"; id: string; highlights: ExportHighlightOverlaySpec[] }
  | { type: "text-overlay"; id: string; boxes: ExportTextBox[] }
  | {
      type: "transition";
      id: string;
      kind: ExportTransitionKind;
      duration_ms: number;
      offset_ms: number;
      from_source_id: string;
      to_source_id: string;
    };

export interface ExportBackgroundNodeV4 {
  type: "background";
  id: string;
  kind: ExportBackgroundKind;
  radius_px: number;
  shadow: null;
  padding_px: number;
}

export interface ExportBackgroundNodeV5 {
  type: "background";
  id: string;
  kind: ExportBackgroundKind;
  radius_px: number;
  shadow: null;
  foreground_scale: number;
}

export type ExportVideoNodeV4 = ExportVideoNodeBase | ExportBackgroundNodeV4;
export type ExportVideoNodeV5 = ExportVideoNodeBase | ExportBackgroundNodeV5;
/** Current graph node shape emitted by the renderer. */
export type ExportVideoNode = ExportVideoNodeV5;

export type ExportSoundKind = "bgm" | "sfx" | "voiceover";

export interface ExportSoundNode {
  type: "sound";
  id: string;
  clip_id: string;
  kind: ExportSoundKind;
  path: string;
  t_start_ms: number;
  duration_ms: number;
  gain: number;
  source_binding: ExportVoiceoverBinding | null;
  source_time_map?: ExportSourceTimelineMap;
}

export type ExportAudioNode = ExportSoundNode;

export interface ExportCompositionGraphV4 {
  schema_version: 4;
  output_width: number;
  output_height: number;
  output_fps: number;
  duration_ms: number;
  video: ExportVideoNodeV4[];
  audio: ExportAudioNode[];
}

export interface ExportCompositionGraphV5 {
  schema_version: typeof EXPORT_COMPOSITION_SCHEMA_VERSION;
  output_width: number;
  output_height: number;
  output_fps: number;
  duration_ms: number;
  video: ExportVideoNodeV5[];
  audio: ExportAudioNode[];
}

export type SupportedExportCompositionGraph = ExportCompositionGraphV4 | ExportCompositionGraphV5;

export type ExportIssueSeverity = "info" | "warning" | "error";

export interface ExportIssue {
  id: string;
  code: string;
  severity: ExportIssueSeverity;
  message: string;
  remediation?: string;
  clip_id?: string;
  output_index?: number;
  property?: string;
}

export interface ExportPreflightOutput {
  output_index: number;
  format: string;
  ready: boolean;
  issues: ExportIssue[];
}

export interface ExportPreflightResult {
  ready: boolean;
  composition_duration_ms: number;
  issues: ExportIssue[];
  outputs: ExportPreflightOutput[];
}

export interface ExportPreflightArgs {
  graph_json: string;
  outputs: Array<{
    format: string;
    resolution: string;
    output_width?: number | null;
    output_height?: number | null;
    fps: number;
    quality: string;
    encoder_options?: unknown;
  }>;
  compiler_issues: ExportIssue[];
}

export type ExportJobStatus =
  | "queued"
  | "rendering"
  | "mixing"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export const ACTIVE_EXPORT_JOB_STATUSES: readonly ExportJobStatus[] = [
  "queued",
  "rendering",
  "mixing",
  "verifying",
];

export interface ExportJobDto {
  id: string;
  story_id: string;
  batch_id: string | null;
  preset_id: string | null;
  format: string;
  resolution: string;
  fps: number;
  quality: string;
  status: ExportJobStatus;
  progress_pct: number;
  phase_progress_pct: number;
  priority: number;
  output_path: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface ExportJobProgressDto {
  job_id: string;
  status: ExportJobStatus;
  pct: number;
  phase_pct: number;
  frame: number;
  fps: number;
  speed: number;
  eta_ms: number;
}

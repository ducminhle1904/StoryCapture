/**
 * Mirrors crates/effects PreviewRenderPlan shape.
 *
 * When the shared-types package re-exports the ts-rs-generated
 * PreviewRenderPlan, swap the local declarations for:
 *   export type { PreviewRenderPlan } from "@storycapture/shared-types";
 * The runtime is pure data shape, so the swap is type-only.
 *
 * Drift guard: if you change anything here, run `cargo test -p effects`
 * and verify `packages/shared-types/src/generated/effects.ts` matches.
 */

export interface ZoomMatrixFrame {
  t_ms: number;
  center: { x: number; y: number };
  scale: number;
}

export interface RippleEvent {
  t_anticipate_ms: number;
  t_impact_ms: number;
  duration_ms: number;
  center: { x: number; y: number };
  max_radius_px: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface HighlightOverlaySpec {
  t_start_ms: number;
  duration_ms: number;
  shape: "ring" | "spotlight";
  center: { x: number; y: number };
  max_radius_px: number;
  bounds?: { x: number; y: number; w: number; h: number } | null;
  padding_px: number;
  radius_px: number;
  stroke_px: number;
  glow_px: number;
  color: { r: number; g: number; b: number; a: number };
  opacity: number;
  png_path?: string | null;
  overlay_pos?: { x: number; y: number } | null;
}

export interface TextBoxPreview {
  t_start_ms: number;
  t_end_ms: number;
  text: string;
  pos: { x: number; y: number };
  size_pt: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface BackgroundPreview {
  kind: "gradient" | "image" | "solid";
  preset_id?: string;
  image_path?: string;
  color?: { r: number; g: number; b: number; a: number };
}

export interface CursorAtlasRef {
  png_sequence_dir: string;
  fps: number;
  frame_count: number;
}

export interface PreviewRenderPlan {
  output_width: number;
  output_height: number;
  fps: number;
  zoom_matrices: ZoomMatrixFrame[];
  cursor_atlas_ref: CursorAtlasRef | null;
  ripples: RippleEvent[];
  highlights: HighlightOverlaySpec[];
  text_boxes: TextBoxPreview[];
  background: BackgroundPreview | null;
}

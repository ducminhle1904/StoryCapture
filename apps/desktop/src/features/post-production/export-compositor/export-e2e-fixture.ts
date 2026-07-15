import type {
  ExportBackgroundKind,
  ExportCompositionGraphV4,
  ExportTrajectoryRef,
  ExportTransitionKind,
} from "@storycapture/shared-types";

export const EXPORT_E2E_TRANSITION_KINDS = [
  "fade",
  "fade-black",
  "fade-white",
  "dissolve",
  "wipe-left",
  "wipe-right",
  "wipe-up",
  "wipe-down",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "circle-open",
  "circle-close",
] as const satisfies readonly ExportTransitionKind[];

export const EXPORT_E2E_BACKGROUND_KINDS = ["ambient", "solid", "gradient", "image"] as const;
export const EXPORT_E2E_CURSOR_TRAJECTORY_KINDS = [
  "actions",
  "trajectory",
  "png-sequence",
] as const;

export interface ExportE2eFixturePaths {
  sourceA: string;
  sourceB: string;
  bgm: string;
  sfx: string;
  voiceover: string;
  actions: string;
  trajectory: string;
  cursorPngSequence: string;
  backgroundImage: string;
}

export interface ExportE2eFixtureVariant {
  transition: ExportTransitionKind;
  background: (typeof EXPORT_E2E_BACKGROUND_KINDS)[number];
  cursorTrajectory: (typeof EXPORT_E2E_CURSOR_TRAJECTORY_KINDS)[number];
}

export const DEFAULT_EXPORT_E2E_VARIANT: ExportE2eFixtureVariant = {
  transition: "fade",
  background: "ambient",
  cursorTrajectory: "actions",
};

function backgroundKind(
  variant: ExportE2eFixtureVariant["background"],
  paths: ExportE2eFixturePaths,
): ExportBackgroundKind {
  if (variant === "ambient") return { kind: "ambient" };
  if (variant === "solid") {
    return { kind: "solid", color: { r: 24, g: 20, b: 32, a: 255 } };
  }
  if (variant === "image") {
    return { kind: "image", asset_id: null, path: paths.backgroundImage };
  }
  return { kind: "gradient", preset_id: "warm-sunset" };
}

function trajectoryRef(
  variant: ExportE2eFixtureVariant["cursorTrajectory"],
  paths: ExportE2eFixturePaths,
): ExportTrajectoryRef {
  const path =
    variant === "actions"
      ? paths.actions
      : variant === "trajectory"
        ? paths.trajectory
        : paths.cursorPngSequence;
  return {
    kind: variant,
    path,
    png_sequence_dir: path,
    fps: 30,
    frame_count: 48,
  };
}

export function createAllEffectsExportGraph(
  paths: ExportE2eFixturePaths,
  variant: ExportE2eFixtureVariant = DEFAULT_EXPORT_E2E_VARIANT,
): ExportCompositionGraphV4 {
  return {
    schema_version: 4,
    output_width: 320,
    output_height: 180,
    output_fps: 30,
    duration_ms: 1_600,
    video: [
      {
        type: "source",
        id: "source-a",
        clip_id: "clip-a",
        path: paths.sourceA,
        pts_offset_ms: 0,
        timeline_start_ms: 0,
        duration_ms: 900,
        source_width: 320,
        source_height: 180,
      },
      {
        type: "source",
        id: "source-b",
        clip_id: "clip-b",
        path: paths.sourceB,
        pts_offset_ms: 800,
        timeline_start_ms: 800,
        duration_ms: 800,
        source_width: 320,
        source_height: 180,
      },
      {
        type: "background",
        id: "background",
        kind: backgroundKind(variant.background, paths),
        radius_px: 12,
        shadow: null,
        padding_px: 12,
      },
      {
        type: "zoom-pan",
        id: "zoom",
        clip_id: "zoom-clip",
        t_start_ms: 0,
        duration_ms: 1_600,
        target: { kind: "cursor" },
        keyframes: [
          {
            t_ms: 0,
            center: { x: 160, y: 90 },
            scale: 1,
            easing: "linear",
          },
          {
            t_ms: 1_600,
            center: { x: 190, y: 80 },
            scale: 1.18,
            easing: "ease-in-out-cubic",
          },
        ],
      },
      {
        type: "cursor-overlay",
        id: "cursor",
        clip_id: "cursor-clip",
        skin: "mac-default",
        size_scale: 0.9,
        motion_preset: "natural",
        preserve_full_motion: true,
        click_effect: { style: "ring", color: "brand", intensity: "normal" },
        color_tint: null,
        t_start_ms: 0,
        duration_ms: 1_600,
        trajectory: trajectoryRef(variant.cursorTrajectory, paths),
      },
      {
        type: "ripple-overlay",
        id: "ripple",
        events: [
          {
            clip_id: "ripple-clip",
            t_anticipate_ms: 350,
            t_impact_ms: 450,
            duration_ms: 450,
            center: { x: 0.42, y: 0.55 },
            max_radius_px: 32,
            color: { r: 255, g: 100, b: 120, a: 220 },
          },
        ],
      },
      {
        type: "highlight-overlay",
        id: "highlight",
        highlights: [
          {
            clip_id: "highlight-clip",
            t_start_ms: 500,
            duration_ms: 700,
            shape: "ring",
            center: { x: 144, y: 99 },
            source_center: { x: 0.45, y: 0.55 },
            source_bounds: { x: 0.34, y: 0.43, w: 0.22, h: 0.2 },
            max_radius_px: 34,
            padding_px: 6,
            radius_px: 8,
            stroke_px: 2,
            glow_px: 10,
            color: { r: 255, g: 210, b: 90, a: 255 },
            opacity: 0.78,
          },
        ],
      },
      {
        type: "text-overlay",
        id: "text",
        boxes: [
          {
            clip_id: "text-clip",
            t_start_ms: 100,
            t_end_ms: 1_500,
            text: "StoryCapture export parity",
            pos: { x: 0.5, y: 0.18 },
            fallback_pos: { x: 0.5, y: 0.18 },
            anchor: { kind: "safe-area", placement: "top" },
            source_binding: {
              kind: "story-text-overlay",
              stepId: "cta",
              ordinal: 1,
            },
            font: {
              kind: "bundled",
              family: "Geist Variable",
              weight: 700,
              style: "normal",
            },
            size_pt: 18,
            color: { r: 255, g: 255, b: 255, a: 255 },
            align: "center",
            max_width_pct: 0.82,
            line_height: 1.15,
            letter_spacing_px: 0.2,
            text_shadow: {
              color: { r: 0, g: 0, b: 0, a: 180 },
              blur_px: 5,
              offset_x_px: 0,
              offset_y_px: 2,
            },
            box_style: {
              padding_px: 8,
              radius_px: 8,
              bg_color: { r: 12, g: 12, b: 16, a: 180 },
              border_color: { r: 255, g: 255, b: 255, a: 40 },
              border_width_px: 1,
              shadow: null,
            },
            anim_in: "fade",
            anim_out: "fade",
            anim_duration_ms: 180,
          },
        ],
      },
      {
        type: "transition",
        id: `transition-${variant.transition}`,
        kind: variant.transition,
        duration_ms: 100,
        offset_ms: 800,
        from_source_id: "source-a",
        to_source_id: "source-b",
      },
    ],
    audio: [
      {
        type: "sound",
        id: "bgm",
        clip_id: "bgm-clip",
        kind: "bgm",
        path: paths.bgm,
        t_start_ms: 0,
        duration_ms: 1_600,
        gain: 0.18,
        source_binding: null,
      },
      {
        type: "sound",
        id: "sfx",
        clip_id: "sfx-clip",
        kind: "sfx",
        path: paths.sfx,
        t_start_ms: 420,
        duration_ms: 260,
        gain: 0.65,
        source_binding: null,
      },
      {
        type: "sound",
        id: "voiceover",
        clip_id: "voiceover-clip",
        kind: "voiceover",
        path: paths.voiceover,
        t_start_ms: 850,
        duration_ms: 600,
        gain: 0.85,
        source_binding: {
          kind: "story-voiceover",
          stepId: "cta",
          ordinal: 1,
        },
      },
    ],
  };
}

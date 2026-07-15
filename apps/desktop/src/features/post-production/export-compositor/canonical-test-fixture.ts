import type {
  ExportCompositionGraphV4,
  ExportTextAnchor,
  ExportTextBox,
  ExportTransitionKind,
  ExportVideoNode,
} from "@storycapture/shared-types";

export function canonicalSource(
  id: string,
  timelineStartMs: number,
  durationMs: number,
): Extract<ExportVideoNode, { type: "source" }> {
  return {
    type: "source",
    id,
    clip_id: `${id}-clip`,
    path: `/tmp/${id}.mp4`,
    pts_offset_ms: timelineStartMs,
    timeline_start_ms: timelineStartMs,
    duration_ms: durationMs,
    source_width: 1_280,
    source_height: 720,
  };
}

export function canonicalTransition(
  kind: ExportTransitionKind,
  fromSourceId = "source-a",
  toSourceId = "source-b",
): Extract<ExportVideoNode, { type: "transition" }> {
  return {
    type: "transition",
    id: `transition-${kind}`,
    kind,
    duration_ms: 200,
    offset_ms: 800,
    from_source_id: fromSourceId,
    to_source_id: toSourceId,
  };
}

export function canonicalTextBox(
  anchor: ExportTextAnchor = { kind: "screen", pos: { x: 0.5, y: 0.5 } },
): ExportTextBox {
  return {
    clip_id: `text-${anchor.kind}`,
    t_start_ms: 0,
    t_end_ms: 2_000,
    text: "Canonical text",
    pos: { x: 0.5, y: 0.5 },
    fallback_pos: { x: 0.42, y: 0.58 },
    anchor,
    source_binding: null,
    font: { kind: "system-default" },
    size_pt: 28,
    color: { r: 255, g: 255, b: 255, a: 255 },
    align: "center",
    max_width_pct: 70,
    line_height: 1.15,
    letter_spacing_px: 0,
    text_shadow: null,
    box_style: null,
    anim_in: "fade",
    anim_out: "fade",
    anim_duration_ms: 200,
  };
}

export function canonicalGraph(
  video: ExportVideoNode[] = [canonicalSource("source-a", 0, 1_000)],
): ExportCompositionGraphV4 {
  return {
    schema_version: 4,
    output_width: 1_280,
    output_height: 720,
    output_fps: 60,
    duration_ms: 2_000,
    video,
    audio: [],
  };
}

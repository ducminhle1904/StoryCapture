import type { RecordingActions } from "@/ipc/actions";

export const ACTIONS: RecordingActions = {
  source_version: 1,
  confidence: "legacy-approximate",
  recording_path: "/tmp/demo.mp4",
  cursor_motion_preset: "natural",
  viewport: { width: 1000, height: 500 },
  capture_rect: { x: 0, y: 0, width: 1000, height: 500 },
  fps_num: 60,
  fps_den: 1,
  frame_count: 600,
  events: [
    {
      source_index: 0,
      confidence: "legacy-approximate",
      step_id: "step-1",
      ordinal: 1,
      verb: "click",
      t_start_ms: 1000,
      t_action_ms: 2000,
      t_end_ms: 2200,
      target: {
        kind: "element",
        label: "Sign In",
        center: { x: 800, y: 300 },
        bounds: { x: 760, y: 280, w: 80, h: 40 },
      },
      secondary_target: null,
      pointer: { button: "left", effect: "click" },
      cursor_timing: null,
      input_timing: { kind: "click", action_ms: 2000 },
    },
  ],
};

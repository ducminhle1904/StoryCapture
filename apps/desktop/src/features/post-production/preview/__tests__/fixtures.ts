import type { RecordingActions } from "@/ipc/actions";

export const ACTIONS: RecordingActions = {
  version: 1,
  recording_path: "/tmp/demo.mp4",
  viewport: { width: 1000, height: 500 },
  capture_rect: { x: 0, y: 0, width: 1000, height: 500 },
  fps: 60,
  frame_count: 600,
  events: [
    {
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
    },
  ],
};

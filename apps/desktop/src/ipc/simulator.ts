import { Channel, invoke } from "@tauri-apps/api/core";

import type { StepFrame } from "./automation";

export const SimulatorMatchKind = {
  Primary: "primary",
  Fuzzy: "fuzzy",
  None: "none",
} as const;
export type SimulatorMatchKind =
  (typeof SimulatorMatchKind)[keyof typeof SimulatorMatchKind];

export interface SimulatorBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SimulatorStepFrame {
  ordinal: number;
  screenshot_path: string | null;
  cursor_xy: [number, number];
  matched_selector: string | null;
  matched_bbox: SimulatorBbox | null;
  match_kind: SimulatorMatchKind;
  duration_ms: number;
}

export type SimulatorEvent =
  | { type: "started"; session_id: string; run_id: string; total_steps: number }
  | { type: "step_started"; ordinal: number }
  | { type: "frame_captured"; ordinal: number; frame: SimulatorStepFrame }
  | { type: "paused"; ordinal: number }
  | { type: "failed"; ordinal: number; error_message: string }
  | { type: "completed"; succeeded: number; failed: number }
  | { type: "cancelled" };

export interface SimulatorStartArgs {
  projectFolder: string;
  storySource: string;
  storyPath: string;
  streamId: string;
  stopAfterOrdinal?: number;
}

export async function simulatorStart(
  args: SimulatorStartArgs,
  onEvent: (e: SimulatorEvent) => void,
): Promise<string> {
  const channel = new Channel<SimulatorEvent>();
  channel.onmessage = onEvent;
  return await invoke<string>("simulator_start", {
    projectFolder: args.projectFolder,
    storySource: args.storySource,
    storyPath: args.storyPath,
    streamId: args.streamId,
    stopAfterOrdinal: args.stopAfterOrdinal ?? null,
    channel,
  });
}

export async function simulatorStepTo(sessionId: string, ordinal: number): Promise<void> {
  await invoke("simulator_step_to", { sessionId, ordinal });
}

export async function simulatorCancel(sessionId: string): Promise<void> {
  await invoke("simulator_cancel", { sessionId });
}

export async function simulatorPromoteFallback(
  sessionId: string,
  ordinal: number,
): Promise<void> {
  await invoke("simulator_promote_fallback", { sessionId, ordinal });
}

/** Re-exported for convenience — matches the crate-level StepFrame type. */
export type { StepFrame };

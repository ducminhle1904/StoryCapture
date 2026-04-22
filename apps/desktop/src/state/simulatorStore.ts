import { create } from "zustand";

import type { SimulatorEvent, SimulatorStepFrame } from "@/ipc/simulator";

export type RunState =
  | "idle"
  | "running"
  | "paused"
  | "complete"
  | "failed"
  | "cancelled";

interface SimulatorState {
  frames: SimulatorStepFrame[];
  currentFrameOrdinal: number | null;
  runState: RunState;
  sessionId: string | null;
  runId: string | null;
  totalSteps: number;
  error: string | null;
  dismissedCoexistenceHint: boolean;
  setCurrentFrameOrdinal: (n: number | null) => void;
  handleEvent: (e: SimulatorEvent) => void;
  resetToIdle: () => void;
  dismissCoexistenceHint: () => void;
}

const HINT_KEY = "simulator:hintDismissed";

function readDismissedHint(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export const useSimulatorStore = create<SimulatorState>((set, get) => ({
  frames: [],
  currentFrameOrdinal: null,
  runState: "idle",
  sessionId: null,
  runId: null,
  totalSteps: 0,
  error: null,
  dismissedCoexistenceHint: readDismissedHint(),

  setCurrentFrameOrdinal: (n) => {
    if (n === null) {
      set({ currentFrameOrdinal: null });
      return;
    }
    const { frames, totalSteps } = get();
    const maxCaptured = frames.length > 0 ? frames[frames.length - 1].ordinal : 0;
    const upperBound = Math.max(1, Math.min(totalSteps || maxCaptured, maxCaptured));
    const clamped = Math.min(Math.max(1, n), upperBound);
    set({ currentFrameOrdinal: clamped });
  },

  handleEvent: (e) => {
    switch (e.type) {
      case "started":
        set({
          runState: "running",
          sessionId: e.session_id,
          runId: e.run_id,
          totalSteps: e.total_steps,
          frames: [],
          currentFrameOrdinal: null,
          error: null,
        });
        break;
      case "frame_captured":
        set((s) => ({
          frames: [...s.frames, e.frame],
          currentFrameOrdinal: e.frame.ordinal,
        }));
        break;
      case "paused":
        set({ runState: "paused", currentFrameOrdinal: e.ordinal });
        break;
      case "completed":
        set({ runState: "complete" });
        break;
      case "failed":
        set({
          runState: "failed",
          error: e.error_message,
          currentFrameOrdinal: e.ordinal,
        });
        break;
      case "cancelled":
        set({ runState: "cancelled", sessionId: null });
        break;
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  },

  resetToIdle: () =>
    set({
      frames: [],
      currentFrameOrdinal: null,
      runState: "idle",
      sessionId: null,
      runId: null,
      totalSteps: 0,
      error: null,
    }),

  dismissCoexistenceHint: () => {
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* noop in constrained envs */
    }
    set({ dismissedCoexistenceHint: true });
  },
}));

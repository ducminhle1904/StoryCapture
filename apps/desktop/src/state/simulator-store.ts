import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { SimulatorEvent, SimulatorStepFrame } from "@/ipc/simulator";

// Playwright's locator error messages embed ANSI SGR escape sequences
// (e.g. `\x1b[2m...\x1b[22m` for dim text). They render as broken boxes
// in our UI; strip them before displaying.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR_RE, "");
}

export type RunState = "idle" | "running" | "paused" | "complete" | "failed" | "cancelled";

interface SimulatorState {
  frames: SimulatorStepFrame[];
  currentFrameOrdinal: number | null;
  runState: RunState;
  sessionId: string | null;
  runId: string | null;
  totalSteps: number;
  error: string | null;
  /** Ordinal of the step currently in flight (started but not yet succeeded/failed). */
  inFlightOrdinal: number | null;
  /** Wall-clock ms when `inFlightOrdinal` started — drives the "taking too long" hint. */
  inFlightStartedAt: number | null;
  /** Ordinal of the most recent failure, kept after run ends so the editor can decorate it. */
  failedOrdinal: number | null;
  dismissedCoexistenceHint: boolean;
  setCurrentFrameOrdinal: (n: number | null) => void;
  handleEvent: (e: SimulatorEvent) => void;
  resetToIdle: () => void;
  dismissCoexistenceHint: () => void;
}

export const useSimulatorStore = create<SimulatorState>()(
  persist(
    (set, get) => ({
      frames: [],
      currentFrameOrdinal: null,
      runState: "idle",
      sessionId: null,
      runId: null,
      totalSteps: 0,
      error: null,
      inFlightOrdinal: null,
      inFlightStartedAt: null,
      failedOrdinal: null,
      dismissedCoexistenceHint: false,

      setCurrentFrameOrdinal: (n) => {
        const current = get().currentFrameOrdinal;
        if (n === null) {
          if (current === null) return;
          set({ currentFrameOrdinal: null });
          return;
        }
        const { frames, totalSteps } = get();
        const maxCaptured = frames.length > 0 ? frames[frames.length - 1].ordinal : 0;
        const upperBound = Math.max(1, Math.min(totalSteps || maxCaptured, maxCaptured));
        const clamped = Math.min(Math.max(1, n), upperBound);
        if (clamped === current) return;
        set({ currentFrameOrdinal: clamped });
      },

      handleEvent: (e) => {
        console.log("[sim:event]", e.type, e);
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
              inFlightOrdinal: null,
              inFlightStartedAt: null,
              failedOrdinal: null,
            });
            break;
          case "step_started":
            set({
              inFlightOrdinal: e.ordinal,
              inFlightStartedAt: Date.now(),
            });
            break;
          case "frame_captured":
            set((s) => ({
              frames: [...s.frames, e.frame],
              currentFrameOrdinal: e.frame.ordinal,
              inFlightOrdinal: s.inFlightOrdinal === e.frame.ordinal ? null : s.inFlightOrdinal,
              inFlightStartedAt: s.inFlightOrdinal === e.frame.ordinal ? null : s.inFlightStartedAt,
            }));
            break;
          case "paused":
            set({
              runState: "paused",
              currentFrameOrdinal: e.ordinal,
              inFlightOrdinal: null,
              inFlightStartedAt: null,
            });
            break;
          case "completed":
            set({
              runState: "complete",
              inFlightOrdinal: null,
              inFlightStartedAt: null,
            });
            break;
          case "failed":
            set({
              runState: "failed",
              error: stripAnsi(e.error_message),
              currentFrameOrdinal: e.ordinal,
              failedOrdinal: e.ordinal,
              inFlightOrdinal: null,
              inFlightStartedAt: null,
            });
            break;
          case "cancelled":
            set({
              runState: "cancelled",
              sessionId: null,
              inFlightOrdinal: null,
              inFlightStartedAt: null,
            });
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
          inFlightOrdinal: null,
          inFlightStartedAt: null,
          failedOrdinal: null,
        }),

      dismissCoexistenceHint: () => {
        if (get().dismissedCoexistenceHint) return;
        set({ dismissedCoexistenceHint: true });
      },
    }),
    {
      name: "simulator:hintDismissed",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ dismissedCoexistenceHint: s.dismissedCoexistenceHint }),
      version: 2,
      migrate: (persisted, version) => {
        // v1 stored the flag as the raw literal "1" under the same key.
        if (version < 2 && persisted === "1") {
          return { dismissedCoexistenceHint: true };
        }
        return persisted as { dismissedCoexistenceHint: boolean };
      },
    },
  ),
);

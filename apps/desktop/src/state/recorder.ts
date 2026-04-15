import { create } from "zustand";

export type RecorderStatus =
  | "idle"
  | "preflight"
  | "recording"
  | "paused"
  | "stopping"
  | "completed"
  | "failed";

export interface CursorPoint {
  x: number;
  y: number;
  t: number;
}

export interface StepProgress {
  index: number;
  status: "pending" | "running" | "succeeded" | "failed";
  verb: string;
}

interface RecorderState {
  status: RecorderStatus;
  sessionId: string | null;
  currentStep: number;
  totalSteps: number;
  cursorPositions: CursorPoint[];
  steps: StepProgress[];
  error: string | null;
  outputPath: string | null;
  elapsedMs: number;

  setStatus: (s: RecorderStatus) => void;
  setSession: (id: string | null) => void;
  setSteps: (steps: StepProgress[]) => void;
  advanceStep: (index: number, status: StepProgress["status"]) => void;
  pushCursor: (p: CursorPoint) => void;
  clearCursor: () => void;
  setError: (e: string | null) => void;
  setOutputPath: (p: string | null) => void;
  setElapsed: (ms: number) => void;
  reset: () => void;
}

const INITIAL: Omit<
  RecorderState,
  | "setStatus"
  | "setSession"
  | "setSteps"
  | "advanceStep"
  | "pushCursor"
  | "clearCursor"
  | "setError"
  | "setOutputPath"
  | "setElapsed"
  | "reset"
> = {
  status: "idle",
  sessionId: null,
  currentStep: 0,
  totalSteps: 0,
  cursorPositions: [],
  steps: [],
  error: null,
  outputPath: null,
  elapsedMs: 0,
};

export const useRecorderStore = create<RecorderState>((set) => ({
  ...INITIAL,
  setStatus: (status) => set({ status }),
  setSession: (sessionId) => set({ sessionId }),
  setSteps: (steps) => set({ steps, totalSteps: steps.length, currentStep: 0 }),
  advanceStep: (index, status) =>
    set((s) => {
      const steps = s.steps.map((step, i) => (i === index ? { ...step, status } : step));
      return { steps, currentStep: Math.max(s.currentStep, index) };
    }),
  pushCursor: (p) =>
    set((s) => ({
      // Keep last 120 points (~2s at 60Hz) to bound SVG render cost.
      cursorPositions: [...s.cursorPositions.slice(-119), p],
    })),
  clearCursor: () => set({ cursorPositions: [] }),
  setError: (error) => set({ error }),
  setOutputPath: (outputPath) => set({ outputPath }),
  setElapsed: (elapsedMs) => set({ elapsedMs }),
  reset: () => set({ ...INITIAL }),
}));

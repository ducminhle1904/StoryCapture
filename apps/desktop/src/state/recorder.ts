import { create } from "zustand";
import {
  getCaptureTarget,
  listCaptureTargets,
  setCaptureTarget as ipcSetCaptureTarget,
  resolvePlaywrightTarget,
  PLAYWRIGHT_AUTO_TARGET,
  captureTargetKey,
  type CaptureTarget,
  type CaptureTargets,
} from "@/ipc/capture";

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

  // Plan 05-01 — capture-target state.
  captureTarget: CaptureTarget | null;
  availableTargets: CaptureTargets | null;

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

  // Plan 05-01 — capture-target actions.
  loadCaptureTargets: () => Promise<void>;
  setCaptureTarget: (target: CaptureTarget) => Promise<void>;

  // Plan 05-02 — Playwright auto-target actions.
  refreshPlaywrightAvailability: () => Promise<void>;
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
  | "loadCaptureTargets"
  | "setCaptureTarget"
  | "refreshPlaywrightAvailability"
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
  captureTarget: null,
  availableTargets: null,
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

  loadCaptureTargets: async () => {
    const [targets, persisted] = await Promise.all([
      listCaptureTargets(),
      getCaptureTarget().catch(() => null),
    ]);
    // Fall back to the first display if nothing is persisted.
    const fallback: CaptureTarget | null = persisted
      ?? (targets.displays[0]
        ? { kind: "display" as const, display_id: targets.displays[0].id }
        : null);
    set({ availableTargets: targets, captureTarget: fallback });
  },
  setCaptureTarget: async (target) => {
    await ipcSetCaptureTarget(target).catch((err) => {
      // Non-fatal: persistence failure shouldn't block the UI choice.
      // eslint-disable-next-line no-console
      console.warn("set_capture_target persistence failed:", err);
    });
    set({ captureTarget: target });
  },

  // Plan 05-02: query the host for the current Playwright window availability
  // and update `availableTargets.playwright_auto_available`. When the
  // Playwright auto-target becomes available AND the user hasn't made an
  // explicit non-auto choice this session, pre-select it per D-01/D-02.
  //
  // Debounced to ≤1 call/s via the module-level `playwrightRefreshGate`
  // (T-05-02-06).
  refreshPlaywrightAvailability: async () => {
    if (!canRefreshPlaywright()) return;
    const resolved = await resolvePlaywrightTarget().catch(() => null);
    const isAvailable = resolved !== null;
    set((s) => {
      const prevTargets = s.availableTargets;
      const nextTargets: CaptureTargets | null = prevTargets
        ? { ...prevTargets, playwright_auto_available: isAvailable }
        : prevTargets;
      // Auto-pre-select the Playwright-auto entry when:
      //   1. it just became available
      //   2. AND the stored target is either null or the first-run sentinel
      //      (we treat "display 0 or first display" as the first-run fallback)
      const currentKey = s.captureTarget
        ? captureTargetKey(s.captureTarget)
        : "";
      const storedIsFirstRunFallback =
        !s.captureTarget ||
        (prevTargets !== null &&
          prevTargets.displays.length > 0 &&
          s.captureTarget.kind === "display" &&
          currentKey ===
            captureTargetKey({
              kind: "display",
              display_id:
                typeof prevTargets.displays[0].id === "bigint"
                  ? Number(prevTargets.displays[0].id)
                  : prevTargets.displays[0].id,
            }));
      const nextTarget =
        isAvailable && storedIsFirstRunFallback
          ? PLAYWRIGHT_AUTO_TARGET
          : s.captureTarget;
      return {
        availableTargets: nextTargets,
        captureTarget: nextTarget,
      };
    });
  },
}));

// ─── Plan 05-02 — debounce gate for refreshPlaywrightAvailability ─────

let lastPlaywrightRefreshMs = 0;
function canRefreshPlaywright(): boolean {
  const now = Date.now();
  if (now - lastPlaywrightRefreshMs < 1000) return false;
  lastPlaywrightRefreshMs = now;
  return true;
}

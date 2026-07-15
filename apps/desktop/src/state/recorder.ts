import { create } from "zustand";
import type { AudioPickerValue } from "@/ipc/audio";
import {
  type CaptureTarget,
  type CaptureTargets,
  captureTargetKey,
  getCaptureTarget,
  setCaptureTarget as ipcSetCaptureTarget,
  listCaptureTargets,
} from "@/ipc/capture";
import { frontendLog } from "@/lib/log";

export type RecorderStatus =
  | "idle"
  | "preflight"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "completed"
  | "repairable"
  | "cancelled"
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

/**
 * Record-path primary-miss error surface. Populated when the executor
 * raises `AutomationError::PrimaryMissNoHeal`; the HUD renders a
 * destructive block plus an "Open in Simulator" action routing into the
 * Editor at the failed step. Cleared on `reset()`.
 */
export interface PrimaryMissInfo {
  /** 1-indexed step ordinal from the executor event. */
  ordinal: number;
  /** Verb excerpt rendered into the heading, e.g. `click "Save"`. */
  verbExcerpt: string;
}

/** Fixed-capacity ring of cursor points. `buffer` slots are reused in
 *  place; `head` is the next write index modulo MAX; `size` is the count
 *  of valid entries (capped at MAX once the ring wraps). */
export interface CursorRing {
  buffer: CursorPoint[];
  head: number;
  size: number;
}

const CURSOR_RING_MAX = 120;

function emptyCursorRing(): CursorRing {
  return { buffer: new Array<CursorPoint>(CURSOR_RING_MAX), head: 0, size: 0 };
}

/** Selector helper: chronological snapshot of a CursorRing. */
export function getCursorPositions(ring: CursorRing): CursorPoint[] {
  if (ring.size === 0) return [];
  const max = ring.buffer.length;
  const start = ring.size < max ? 0 : ring.head;
  const out: CursorPoint[] = [];
  for (let i = 0; i < ring.size; i++) {
    out.push(ring.buffer[(start + i) % max]);
  }
  return out;
}

export interface RecorderData {
  status: RecorderStatus;
  sessionId: string | null;
  currentStep: number;
  totalSteps: number;
  cursorPositions: CursorRing;
  steps: StepProgress[];
  error: string | null;
  outputPath: string | null;
  elapsedMs: number;

  captureTarget: CaptureTarget | null;
  availableTargets: CaptureTargets | null;

  /** `null` = no audio. `"default"` = cpal's default input. Any other
   *  string is a specific device id. Non-sticky: resets to null on
   *  mount and recording completion. */
  audioDeviceId: AudioPickerValue;

  /** Per-recording real OS cursor capture flag. Non-sticky, defaults off. */
  includeCursor: boolean;

  /** Per-recording chrome-hiding flag. Non-sticky, defaults to true.
   *  When true, the recorder appends `--app=<meta.app>` to
   *  LaunchConfig.args before automation starts. */
  chromeHiding: boolean;

  /** Record-path primary-miss payload. Set from the StepFailed handler
   *  when the error_message matches the locked PrimaryMissNoHeal copy;
   *  consumed by the HUD to render the destructive block + "Open in
   *  Simulator" action. `null` when no such error is active. */
  primaryMiss: PrimaryMissInfo | null;
}

export interface RecorderActions {
  setStatus: (s: RecorderStatus) => void;
  setSession: (id: string | null) => void;
  setSteps: (steps: StepProgress[]) => void;
  advanceStep: (index: number, status: StepProgress["status"]) => void;
  pushCursor: (p: CursorPoint) => void;
  clearCursor: () => void;
  setError: (e: string | null) => void;
  setOutputPath: (p: string | null) => void;
  setElapsed: (ms: number) => void;
  resetTake: () => void;
  reset: () => void;

  loadCaptureTargets: () => Promise<void>;
  setCaptureTarget: (target: CaptureTarget) => Promise<void>;

  setAudioDeviceId: (id: AudioPickerValue) => void;

  setIncludeCursor: (v: boolean) => void;
  setChromeHiding: (v: boolean) => void;

  /** Set or clear the record-path PrimaryMissNoHeal payload the HUD
   *  renders. Pass `null` to dismiss the block. */
  setPrimaryMiss: (info: PrimaryMissInfo | null) => void;
}

export type RecorderState = RecorderData & RecorderActions;

const INITIAL: RecorderData = {
  status: "idle",
  sessionId: null,
  currentStep: 0,
  totalSteps: 0,
  cursorPositions: emptyCursorRing(),
  steps: [],
  error: null,
  outputPath: null,
  elapsedMs: 0,
  captureTarget: null,
  availableTargets: null,
  // Non-sticky: reset() is called on recorder-view mount and recording
  // completion, so every new recording starts with "No audio" / real cursor
  // off / browser chrome hidden regardless of prior session state.
  audioDeviceId: null,
  includeCursor: false,
  chromeHiding: true,
  // No primary-miss on a fresh recording.
  primaryMiss: null,
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
    set((s) => {
      // In-place ring write; returning a new outer object is what zustand
      // needs to notify subscribers. The buffer array is reused.
      const max = s.cursorPositions.buffer.length;
      s.cursorPositions.buffer[s.cursorPositions.head] = p;
      return {
        cursorPositions: {
          buffer: s.cursorPositions.buffer,
          head: (s.cursorPositions.head + 1) % max,
          size: Math.min(s.cursorPositions.size + 1, max),
        },
      };
    }),
  clearCursor: () => set({ cursorPositions: emptyCursorRing() }),
  setError: (error) => set({ error }),
  setOutputPath: (outputPath) => set({ outputPath }),
  setElapsed: (elapsedMs) => set({ elapsedMs }),
  resetTake: () =>
    set((state) => ({
      ...INITIAL,
      captureTarget: state.captureTarget,
      availableTargets: state.availableTargets,
    })),
  reset: () => set({ ...INITIAL }),
  setAudioDeviceId: (audioDeviceId) => set({ audioDeviceId }),
  setIncludeCursor: (includeCursor) => set({ includeCursor }),
  setChromeHiding: (chromeHiding) => set({ chromeHiding }),
  setPrimaryMiss: (primaryMiss) => set({ primaryMiss }),

  loadCaptureTargets: async () => {
    const [targets, persisted] = await Promise.all([
      listCaptureTargets(),
      getCaptureTarget().catch(() => null),
    ]);
    // Fall back to the first display if nothing is persisted.
    const normalizedPersisted: CaptureTarget | null =
      persisted?.kind === "display"
        ? persisted
        : persisted?.kind === "display_region"
          ? { kind: "display", display_id: persisted.display_id }
          : null;
    const fallback: CaptureTarget | null =
      normalizedPersisted ??
      (targets.displays[0]
        ? { kind: "display" as const, display_id: targets.displays[0].id }
        : null);
    set({ availableTargets: targets, captureTarget: fallback });
  },
  setCaptureTarget: async (target) => {
    // Short-circuit when the caller re-asserts the same target. Avoids
    // a spurious IPC round-trip + zustand set on TargetPicker
    // render-time no-ops.
    const current = useRecorderStore.getState().captureTarget;
    if (current && captureTargetKey(current) === captureTargetKey(target)) {
      return;
    }
    await ipcSetCaptureTarget(target).catch((err) => {
      // Non-fatal: persistence failure shouldn't block the UI choice.
      frontendLog.warn(
        "recorderStore",
        "set_capture_target persistence failed (UI choice still applied)",
        {
          error: err,
          fields: { target_key: captureTargetKey(target) },
        },
      );
    });
    set({ captureTarget: target });
  },
}));

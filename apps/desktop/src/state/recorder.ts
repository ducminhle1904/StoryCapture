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
import type { AudioPickerValue } from "@/ipc/audio";
import { getAppSettings, setLivePreviewEnabled as ipcSetLivePreviewEnabled } from "@/ipc/settings";

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

  /** Per-recording include-cursor flag. Non-sticky, defaults to true. */
  includeCursor: boolean;

  /** Per-recording chrome-hiding flag. Non-sticky, defaults to false.
   *  When true, the recorder appends `--app=<meta.app>` to
   *  LaunchConfig.args before automation starts. */
  chromeHiding: boolean;

  /** Phase 09-02 — persisted Options toggle for the in-recorder live
   *  preview pane. Default ON (D-11); hydrated from app_settings on
   *  first access. */
  livePreviewEnabled: boolean;
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
  reset: () => void;

  loadCaptureTargets: () => Promise<void>;
  setCaptureTarget: (target: CaptureTarget) => Promise<void>;

  refreshPlaywrightAvailability: () => Promise<void>;

  setAudioDeviceId: (id: AudioPickerValue) => void;

  setIncludeCursor: (v: boolean) => void;
  setChromeHiding: (v: boolean) => void;

  /** Phase 09-02 — flip the live-preview toggle; persists through
   *  `set_live_preview_enabled` so the choice survives app restarts. */
  setLivePreviewEnabled: (v: boolean) => void;
  /** Phase 09-02 — hydrate `livePreviewEnabled` from app_settings. Safe
   *  to call more than once; silently no-ops on IPC error. */
  hydrateLivePreviewEnabled: () => Promise<void>;
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
  // completion, so every new recording starts with "No audio" / cursor
  // on / chrome-hiding off regardless of prior session state.
  audioDeviceId: null,
  includeCursor: true,
  chromeHiding: false,
  // Default ON per D-11; hydrated from app_settings by
  // `hydrateLivePreviewEnabled` on recorder-view mount.
  livePreviewEnabled: true,
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
  reset: () => set({ ...INITIAL }),
  setAudioDeviceId: (audioDeviceId) => set({ audioDeviceId }),
  setIncludeCursor: (includeCursor) => set({ includeCursor }),
  setChromeHiding: (chromeHiding) => set({ chromeHiding }),
  setLivePreviewEnabled: (livePreviewEnabled) => {
    set({ livePreviewEnabled });
    ipcSetLivePreviewEnabled(livePreviewEnabled).catch(() => {
      /* non-fatal: persistence failure shouldn't block the UI choice */
    });
  },
  hydrateLivePreviewEnabled: async () => {
    try {
      const s = await getAppSettings();
      set({ livePreviewEnabled: s.live_preview_enabled });
    } catch {
      /* non-fatal: stick with the INITIAL default */
    }
  },

  loadCaptureTargets: async () => {
    const [targets, persisted] = await Promise.all([
      listCaptureTargets(),
      getCaptureTarget().catch(() => null),
    ]);
    // Fall back to the first display if nothing is persisted.
    const fallback: CaptureTarget | null =
      persisted ??
      (targets.displays[0]
        ? { kind: "display" as const, display_id: targets.displays[0].id }
        : null);
    set({ availableTargets: targets, captureTarget: fallback });
  },
  setCaptureTarget: async (target) => {
    // Backlog #12 — short-circuit when the caller re-asserts the same
    // target. Avoids a spurious IPC round-trip + zustand set on the
    // TargetPicker render-time no-ops.
    const current = useRecorderStore.getState().captureTarget;
    if (current && captureTargetKey(current) === captureTargetKey(target)) {
      return;
    }
    await ipcSetCaptureTarget(target).catch((err) => {
      // Non-fatal: persistence failure shouldn't block the UI choice.
      // eslint-disable-next-line no-console
      console.warn("set_capture_target persistence failed:", err);
    });
    set({ captureTarget: target });
  },

  // Query the host for Playwright window availability and update
  // `availableTargets.playwright_auto_available`. When the Playwright
  // auto-target becomes available AND the user hasn't made an explicit
  // non-auto choice this session, pre-select it. Debounced to ≤1 call/s
  // via the module-level gate below.
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
      const currentKey = s.captureTarget ? captureTargetKey(s.captureTarget) : "";
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
        isAvailable && storedIsFirstRunFallback ? PLAYWRIGHT_AUTO_TARGET : s.captureTarget;
      return {
        availableTargets: nextTargets,
        captureTarget: nextTarget,
      };
    });
  },
}));

// ─── Debounce gate for refreshPlaywrightAvailability ─────

let lastPlaywrightRefreshMs = 0;
function canRefreshPlaywright(): boolean {
  const now = Date.now();
  if (now - lastPlaywrightRefreshMs < 1000) return false;
  lastPlaywrightRefreshMs = now;
  return true;
}

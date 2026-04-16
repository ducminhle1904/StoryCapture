/**
 * Zustand store for Dry-Run UI state.
 *
 * Tracks per-step status, timing, fallback chains, and summary.
 * Session-ephemeral -- no persistence needed.
 */

import { create } from "zustand";

export interface SelectorAttempt {
  strategy: string;
  selector: string;
  succeeded: boolean;
  durationMs: number;
}

export type DryRunStepStatus = "queued" | "running" | "pass" | "fail" | "skipped";

export interface DryRunSummary {
  total: number;
  passed: number;
  failed: number;
  totalMs: number;
}

export interface DryRunEvent {
  kind: "Queued" | "Running" | "Pass" | "Fail" | "Skipped" | "Summary";
  step_id?: string;
  duration_ms?: number;
  fallback_chain?: SelectorAttempt[];
  error?: string;
  summary?: DryRunSummary;
}

export interface DryRunStore {
  taskId: string | null;
  statusByStep: Record<string, DryRunStepStatus>;
  timingByStep: Record<string, number>;
  fallbackChainByStep: Record<string, SelectorAttempt[]>;
  summary: DryRunSummary | null;
  panelOpen: boolean;
  // actions
  setTaskId: (id: string) => void;
  handleEvent: (ev: DryRunEvent) => void;
  togglePanel: () => void;
  reset: () => void;
}

export const useDryRunStore = create<DryRunStore>((set) => ({
  taskId: null,
  statusByStep: {},
  timingByStep: {},
  fallbackChainByStep: {},
  summary: null,
  panelOpen: false,

  setTaskId: (id: string) => {
    set({ taskId: id, summary: null, statusByStep: {}, timingByStep: {}, fallbackChainByStep: {} });
  },

  handleEvent: (ev: DryRunEvent) => {
    switch (ev.kind) {
      case "Queued":
        if (ev.step_id) {
          set((s) => ({
            statusByStep: { ...s.statusByStep, [ev.step_id!]: "queued" },
          }));
        }
        break;
      case "Running":
        if (ev.step_id) {
          set((s) => ({
            statusByStep: { ...s.statusByStep, [ev.step_id!]: "running" },
          }));
        }
        break;
      case "Pass":
        if (ev.step_id) {
          set((s) => ({
            statusByStep: { ...s.statusByStep, [ev.step_id!]: "pass" },
            timingByStep: { ...s.timingByStep, [ev.step_id!]: ev.duration_ms ?? 0 },
            fallbackChainByStep: {
              ...s.fallbackChainByStep,
              [ev.step_id!]: ev.fallback_chain ?? [],
            },
          }));
        }
        break;
      case "Fail":
        if (ev.step_id) {
          set((s) => ({
            statusByStep: { ...s.statusByStep, [ev.step_id!]: "fail" },
            timingByStep: { ...s.timingByStep, [ev.step_id!]: ev.duration_ms ?? 0 },
            fallbackChainByStep: {
              ...s.fallbackChainByStep,
              [ev.step_id!]: ev.fallback_chain ?? [],
            },
          }));
        }
        break;
      case "Skipped":
        if (ev.step_id) {
          set((s) => ({
            statusByStep: { ...s.statusByStep, [ev.step_id!]: "skipped" },
          }));
        }
        break;
      case "Summary":
        if (ev.summary) {
          set({ summary: ev.summary, panelOpen: true });
        }
        break;
    }
  },

  togglePanel: () => {
    set((s) => ({ panelOpen: !s.panelOpen }));
  },

  reset: () => {
    set({
      taskId: null,
      statusByStep: {},
      timingByStep: {},
      fallbackChainByStep: {},
      summary: null,
    });
  },
}));

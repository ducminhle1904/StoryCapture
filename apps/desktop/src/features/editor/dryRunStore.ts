/** Zustand store for Dry-Run UI state. Session-ephemeral. */

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
          const stepId = ev.step_id;
          set((s) => ({
            statusByStep: { ...s.statusByStep, [stepId]: "queued" },
          }));
        }
        break;
      case "Running":
        if (ev.step_id) {
          const stepId = ev.step_id;
          set((s) => ({
            statusByStep: { ...s.statusByStep, [stepId]: "running" },
          }));
        }
        break;
      case "Pass":
        if (ev.step_id) {
          const stepId = ev.step_id;
          set((s) => ({
            statusByStep: { ...s.statusByStep, [stepId]: "pass" },
            timingByStep: { ...s.timingByStep, [stepId]: ev.duration_ms ?? 0 },
            fallbackChainByStep: {
              ...s.fallbackChainByStep,
              [stepId]: ev.fallback_chain ?? [],
            },
          }));
        }
        break;
      case "Fail":
        if (ev.step_id) {
          const stepId = ev.step_id;
          set((s) => ({
            statusByStep: { ...s.statusByStep, [stepId]: "fail" },
            timingByStep: { ...s.timingByStep, [stepId]: ev.duration_ms ?? 0 },
            fallbackChainByStep: {
              ...s.fallbackChainByStep,
              [stepId]: ev.fallback_chain ?? [],
            },
          }));
        }
        break;
      case "Skipped":
        if (ev.step_id) {
          const stepId = ev.step_id;
          set((s) => ({
            statusByStep: { ...s.statusByStep, [stepId]: "skipped" },
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

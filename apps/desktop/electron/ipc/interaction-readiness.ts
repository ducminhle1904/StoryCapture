import type { WebContents } from "electron";

import type { ActionTarget } from "./action-timeline";
import { simulatorTargetReadinessScript } from "./simulator-dom";
import type { TargetVisibilityDiagnostics } from "./target-visibility";

export type InteractionReadinessReason =
  | "not_found"
  | "detached"
  | "hidden"
  | "disabled"
  | "not_file_input"
  | "invalid_bounds"
  | "outside_viewport"
  | "covered"
  | "unstable_geometry";

export type InteractionObservation =
  | {
      status: "ready";
      target: ActionTarget;
      diagnostics?: TargetVisibilityDiagnostics;
    }
  | {
      status: "not_ready";
      reason: InteractionReadinessReason;
      diagnostics?: TargetVisibilityDiagnostics;
    };

export interface InteractionReadinessResult {
  target: ActionTarget;
  diagnostics?: TargetVisibilityDiagnostics;
  observations: number;
  elapsedActiveMs: number;
}

export class InteractionReadinessError extends Error {
  readonly reason: InteractionReadinessReason;
  readonly diagnostics?: TargetVisibilityDiagnostics;

  constructor(reason: InteractionReadinessReason, diagnostics?: TargetVisibilityDiagnostics) {
    super(`interaction target was not ready: ${reason}`);
    this.name = "InteractionReadinessError";
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

export async function observeInteractionTarget(input: {
  contents: WebContents;
  target: unknown;
  targetNth?: number;
  selector?: string | null;
  label?: string | null;
  requireEnabled: boolean;
}): Promise<InteractionObservation> {
  const observation = (await input.contents.executeJavaScript(
    simulatorTargetReadinessScript(
      input.target,
      input.targetNth,
      input.selector,
      input.requireEnabled,
    ),
  )) as InteractionObservation;
  if (observation.status !== "ready") return observation;
  return {
    status: "ready",
    target: {
      ...observation.target,
      label: input.label ?? observation.target.label,
    },
    diagnostics: observation.diagnostics,
  };
}

function targetDeltaPx(left: ActionTarget, right: ActionTarget): number {
  return Math.hypot(left.center.x - right.center.x, left.center.y - right.center.y);
}

export async function waitForInteractionReadiness(input: {
  observe: () => Promise<InteractionObservation>;
  wait: (durationMs: number) => Promise<boolean | undefined>;
  timeoutMs: number;
  pollIntervalMs?: number;
  stableObservations?: number;
  stabilityThresholdPx?: number;
}): Promise<InteractionReadinessResult> {
  const timeoutMs = Math.max(0, Math.min(30_000, input.timeoutMs));
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 100);
  const stableObservations = Math.max(1, input.stableObservations ?? 2);
  const stabilityThresholdPx = Math.max(0, input.stabilityThresholdPx ?? 1);
  let elapsedActiveMs = 0;
  let observations = 0;
  let stableCount = 0;
  let previousTarget: ActionTarget | null = null;
  let lastReason: InteractionReadinessReason = "not_found";
  let lastDiagnostics: TargetVisibilityDiagnostics | undefined;

  while (elapsedActiveMs <= timeoutMs) {
    const observation = await input.observe();
    observations += 1;
    if (observation.status === "ready") {
      stableCount =
        previousTarget && targetDeltaPx(previousTarget, observation.target) <= stabilityThresholdPx
          ? stableCount + 1
          : 1;
      previousTarget = observation.target;
      lastDiagnostics = observation.diagnostics;
      if (stableCount >= stableObservations) {
        return {
          target: observation.target,
          diagnostics: observation.diagnostics,
          observations,
          elapsedActiveMs,
        };
      }
    } else {
      lastReason = observation.reason;
      lastDiagnostics = observation.diagnostics;
      stableCount = 0;
      previousTarget = null;
    }
    if (elapsedActiveMs >= timeoutMs) break;
    const delayMs = Math.min(pollIntervalMs, timeoutMs - elapsedActiveMs);
    if ((await input.wait(delayMs)) === false) {
      throw new InteractionReadinessError(lastReason, lastDiagnostics);
    }
    elapsedActiveMs += delayMs;
  }

  throw new InteractionReadinessError(lastReason, lastDiagnostics);
}

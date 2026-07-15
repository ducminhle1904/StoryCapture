import { createHash } from "node:crypto";
import type { ActionScrollTiming, ActionTarget } from "./action-timeline";
import type { InteractionObservation, InteractionReadinessReason } from "./interaction-readiness";
import type { ParsedCommand } from "./story-parser";
import type { TargetVisibilityDiagnostics } from "./target-visibility";

export type RuntimeTargetSource = "sidecar_primary" | "story_target" | "sidecar_fallback";
export type RuntimeTargetCandidatesMode = "off" | "shadow" | "enforce";

export type RuntimeTargetEndpointKey = "target" | "from" | "to";

export interface RuntimeTargetCandidateGroup {
  primary?: unknown;
  fallbacks?: unknown[];
}

export interface RuntimeTargetSidecarStep extends RuntimeTargetCandidateGroup {
  from?: RuntimeTargetCandidateGroup;
  to?: RuntimeTargetCandidateGroup;
}

export interface RuntimeTargetSidecar {
  version: number;
  steps: Record<string, RuntimeTargetSidecarStep>;
}

export interface RuntimeTargetCandidate {
  key: string;
  source: RuntimeTargetSource;
  fallbackIndex: number | null;
  target: unknown;
  targetNth?: number;
  summary: {
    kind: string;
    nth: number | null;
  };
}

export interface RuntimeTargetCandidateDiagnostic {
  source: Exclude<RuntimeTargetSource, "story_target"> | "sidecar";
  fallbackIndex: number | null;
  reason: "unsupported_sidecar_version" | "malformed_target";
}

export interface RuntimeTargetCandidateSet {
  eligible: boolean;
  candidates: RuntimeTargetCandidate[];
  diagnostics: RuntimeTargetCandidateDiagnostic[];
}

export interface RuntimeTargetAttempt {
  key: string;
  source: RuntimeTargetSource;
  fallbackIndex: number | null;
  reason: InteractionReadinessReason;
}

export interface RuntimeTargetResolution {
  candidate: RuntimeTargetCandidate;
  target: ActionTarget;
  diagnostics?: TargetVisibilityDiagnostics;
  attempts: RuntimeTargetAttempt[];
  scrollTiming: ActionScrollTiming | null;
}

export class RuntimeTargetAttemptError extends Error {
  readonly reason: InteractionReadinessReason;
  readonly diagnostics?: TargetVisibilityDiagnostics;

  constructor(reason: InteractionReadinessReason, diagnostics?: TargetVisibilityDiagnostics) {
    super(`runtime target candidate was not ready: ${reason}`);
    this.name = "RuntimeTargetAttemptError";
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

export class RuntimeTargetCandidatesExhaustedError extends Error {
  readonly phase = "readiness";
  readonly reason = "target_candidates_exhausted";
  readonly attempts: RuntimeTargetAttempt[];
  readonly diagnostics: { attempts: RuntimeTargetAttempt[] };

  constructor(attempts: RuntimeTargetAttempt[]) {
    super("runtime target candidates exhausted");
    this.name = "RuntimeTargetCandidatesExhaustedError";
    this.attempts = attempts;
    this.diagnostics = { attempts };
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function normalizedNth(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function normalizedTarget(
  value: unknown,
  explicitNth?: number,
): { target: unknown; targetNth?: number; canonical: string; kind: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || !record.kind.trim()) return null;
  if (!("value" in record) || record.value == null) return null;
  const targetNth = explicitNth ?? normalizedNth(record.nth);
  if (record.nth != null && targetNth == null) return null;
  const target = { kind: record.kind, value: stableValue(record.value) };
  return {
    target,
    ...(targetNth == null ? {} : { targetNth }),
    canonical: JSON.stringify({ target, nth: targetNth ?? null }),
    kind: record.kind,
  };
}

function candidate(
  source: RuntimeTargetSource,
  fallbackIndex: number | null,
  value: unknown,
  explicitNth?: number,
): RuntimeTargetCandidate | null {
  const normalized = normalizedTarget(value, explicitNth);
  if (!normalized) return null;
  const digest = createHash("sha256").update(normalized.canonical).digest("hex").slice(0, 16);
  return {
    key: `target:${digest}`,
    source,
    fallbackIndex,
    target: normalized.target,
    ...(normalized.targetNth == null ? {} : { targetNth: normalized.targetNth }),
    summary: {
      kind: normalized.kind,
      nth: normalized.targetNth ?? null,
    },
  };
}

export function runtimeTargetCandidatesMode(
  value = process.env.STORYCAPTURE_RUNTIME_TARGET_MODE,
  platform = process.platform,
): RuntimeTargetCandidatesMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "shadow" || normalized === "enforce") {
    return normalized;
  }
  return platform === "darwin" ? "shadow" : "off";
}

export function buildRuntimeTargetCandidates(input: {
  command: ParsedCommand;
  sidecar: RuntimeTargetSidecar;
  endpointKey?: RuntimeTargetEndpointKey;
}): RuntimeTargetCandidateSet {
  const diagnostics: RuntimeTargetCandidateDiagnostic[] = [];
  const endpointKey = input.endpointKey ?? "target";
  const storyTarget = endpointKey === "target" ? input.command.target : input.command[endpointKey];
  const storyTargetNth =
    endpointKey === "target"
      ? input.command.target_nth
      : endpointKey === "from"
        ? input.command.from_nth
        : input.command.to_nth;
  const storyCandidate = candidate("story_target", null, storyTarget, storyTargetNth);

  if (input.sidecar.version !== 1) {
    diagnostics.push({
      source: "sidecar",
      fallbackIndex: null,
      reason: "unsupported_sidecar_version",
    });
    return {
      eligible: false,
      candidates: storyCandidate ? [storyCandidate] : [],
      diagnostics,
    };
  }

  const stepId = input.command.step_id?.trim();
  const hasStep = Boolean(stepId && Object.hasOwn(input.sidecar.steps, stepId));
  const stepValue = stepId ? input.sidecar.steps[stepId] : undefined;
  if (!hasStep) {
    return {
      eligible: false,
      candidates: storyCandidate ? [storyCandidate] : [],
      diagnostics,
    };
  }
  if (!stepValue || typeof stepValue !== "object" || Array.isArray(stepValue)) {
    diagnostics.push({
      source: "sidecar",
      fallbackIndex: null,
      reason: "malformed_target",
    });
    return {
      eligible: true,
      candidates: storyCandidate ? [storyCandidate] : [],
      diagnostics,
    };
  }
  const step = stepValue as RuntimeTargetSidecarStep;
  const group = endpointKey === "target" ? step : step[endpointKey];
  if (endpointKey !== "target" && group == null) {
    return {
      eligible: false,
      candidates: storyCandidate ? [storyCandidate] : [],
      diagnostics,
    };
  }
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    diagnostics.push({
      source: "sidecar",
      fallbackIndex: null,
      reason: "malformed_target",
    });
    return {
      eligible: true,
      candidates: storyCandidate ? [storyCandidate] : [],
      diagnostics,
    };
  }

  const ordered: RuntimeTargetCandidate[] = [];
  if (group.primary != null) {
    const primary = candidate("sidecar_primary", null, group.primary);
    if (primary) ordered.push(primary);
    else {
      diagnostics.push({
        source: "sidecar_primary",
        fallbackIndex: null,
        reason: "malformed_target",
      });
    }
  }
  if (storyCandidate) ordered.push(storyCandidate);
  for (const [fallbackIndex, value] of (group.fallbacks ?? []).entries()) {
    const fallback = candidate("sidecar_fallback", fallbackIndex, value);
    if (fallback) ordered.push(fallback);
    else {
      diagnostics.push({
        source: "sidecar_fallback",
        fallbackIndex,
        reason: "malformed_target",
      });
    }
  }

  const seen = new Set<string>();
  return {
    eligible: true,
    candidates: ordered.filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    }),
    diagnostics,
  };
}

function orderedAttempts(
  candidates: RuntimeTargetCandidate[],
  failures: Map<string, RuntimeTargetAttempt>,
): RuntimeTargetAttempt[] {
  return candidates.flatMap((item) => {
    const attempt = failures.get(item.key);
    return attempt ? [attempt] : [];
  });
}

function rememberFailure(
  failures: Map<string, RuntimeTargetAttempt>,
  candidate: RuntimeTargetCandidate,
  reason: InteractionReadinessReason,
): void {
  failures.set(candidate.key, {
    key: candidate.key,
    source: candidate.source,
    fallbackIndex: candidate.fallbackIndex,
    reason,
  });
}

export async function resolveRuntimeTargetCandidates(input: {
  candidates: RuntimeTargetCandidate[];
  timeoutMs: number;
  wait: (durationMs: number) => Promise<boolean | undefined>;
  observe: (candidate: RuntimeTargetCandidate) => Promise<InteractionObservation>;
  attempt: (
    candidate: RuntimeTargetCandidate,
    timeoutMs: number,
    wait: (durationMs: number) => Promise<boolean | undefined>,
  ) => Promise<{
    target: ActionTarget;
    diagnostics?: TargetVisibilityDiagnostics;
    scrollTiming: ActionScrollTiming | null;
  }>;
  pollIntervalMs?: number;
  candidateAttemptMs?: number;
}): Promise<RuntimeTargetResolution> {
  const timeoutMs = Math.max(0, Math.min(30_000, input.timeoutMs));
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 100);
  const candidateAttemptMs = Math.max(100, input.candidateAttemptMs ?? 2_000);
  const failures = new Map<string, RuntimeTargetAttempt>();
  let elapsedActiveMs = 0;

  const sharedWait = async (durationMs: number): Promise<boolean> => {
    const remainingMs = Math.max(0, timeoutMs - elapsedActiveMs);
    if (remainingMs <= 0) return false;
    const boundedMs = Math.min(Math.max(0, durationMs), remainingMs);
    if (boundedMs <= 0) return false;
    const result = await input.wait(boundedMs);
    if (result === false) return false;
    elapsedActiveMs += boundedMs;
    return true;
  };

  while (elapsedActiveMs <= timeoutMs) {
    for (let index = 0; index < input.candidates.length; index += 1) {
      const current = input.candidates[index];
      const remainingMs = Math.max(0, timeoutMs - elapsedActiveMs);
      if (remainingMs <= 0) break;
      try {
        const resolved = await input.attempt(
          current,
          Math.min(candidateAttemptMs, remainingMs),
          sharedWait,
        );
        let higherPriorityReady = false;
        for (let higherIndex = 0; higherIndex < index; higherIndex += 1) {
          const higher = input.candidates[higherIndex];
          const observation = await input.observe(higher);
          if (observation.status === "ready") {
            higherPriorityReady = true;
            break;
          }
          rememberFailure(failures, higher, observation.reason);
        }
        if (higherPriorityReady) continue;
        return {
          candidate: current,
          target: resolved.target,
          diagnostics: resolved.diagnostics,
          attempts: orderedAttempts(input.candidates, failures),
          scrollTiming: resolved.scrollTiming,
        };
      } catch (error) {
        if (!(error instanceof RuntimeTargetAttemptError)) throw error;
        rememberFailure(failures, current, error.reason);
      }
    }

    const remainingMs = Math.max(0, timeoutMs - elapsedActiveMs);
    if (remainingMs <= 0 || !(await sharedWait(Math.min(pollIntervalMs, remainingMs)))) break;
  }

  for (const item of input.candidates) {
    if (!failures.has(item.key)) rememberFailure(failures, item, "not_found");
  }
  throw new RuntimeTargetCandidatesExhaustedError(orderedAttempts(input.candidates, failures));
}

import { describe, expect, it, vi } from "vitest";
import type { ActionTarget } from "./action-timeline";
import type { InteractionReadinessReason } from "./interaction-readiness";
import {
  buildRuntimeTargetCandidates,
  RuntimeTargetAttemptError,
  RuntimeTargetCandidatesExhaustedError,
  resolveRuntimeTargetCandidates,
  runtimeTargetCandidatesMode,
} from "./runtime-target-candidates";
import type { ParsedCommand } from "./story-parser";

function command(target: unknown, targetNth?: number): ParsedCommand {
  return {
    verb: "click",
    step_id: "step-1",
    span: { start: 0, end: 1, line: 1, col: 1 },
    target,
    ...(targetNth == null ? {} : { target_nth: targetNth }),
  };
}

function target(label: string): ActionTarget {
  return {
    kind: "selector",
    label,
    center: { x: 20, y: 20 },
    bounds: { x: 10, y: 10, w: 20, h: 20 },
  };
}

function failure(reason: InteractionReadinessReason): RuntimeTargetAttemptError {
  return new RuntimeTargetAttemptError(reason);
}

describe("runtime target candidate construction", () => {
  it("orders promoted primary, distinct story target, then stored fallbacks", () => {
    const result = buildRuntimeTargetCandidates({
      command: command({ kind: "selector", value: "#story" }, 1),
      sidecar: {
        version: 1,
        steps: {
          "step-1": {
            primary: { kind: "selector", value: "#primary" },
            fallbacks: [
              { kind: "selector", value: "#fallback-1" },
              { kind: "selector", value: "#fallback-2", nth: 2 },
            ],
          },
        },
      },
    });

    expect(result.eligible).toBe(true);
    expect(
      result.candidates.map(({ source, fallbackIndex, summary }) => ({
        source,
        fallbackIndex,
        nth: summary.nth,
      })),
    ).toEqual([
      { source: "sidecar_primary", fallbackIndex: null, nth: null },
      { source: "story_target", fallbackIndex: null, nth: 1 },
      { source: "sidecar_fallback", fallbackIndex: 0, nth: null },
      { source: "sidecar_fallback", fallbackIndex: 1, nth: 2 },
    ]);
  });

  it("structurally deduplicates targets without exposing selector text in keys", () => {
    const result = buildRuntimeTargetCandidates({
      command: command({ kind: "selector", value: "#same" }),
      sidecar: {
        version: 1,
        steps: {
          "step-1": {
            primary: { value: "#same", kind: "selector" },
            fallbacks: [{ kind: "selector", value: "#same" }],
          },
        },
      },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].source).toBe("sidecar_primary");
    expect(result.candidates[0].key).not.toContain("#same");
  });

  it("retains the story target and reports only malformed sidecar records", () => {
    const result = buildRuntimeTargetCandidates({
      command: command({ kind: "selector", value: "#story" }),
      sidecar: {
        version: 1,
        steps: {
          "step-1": {
            primary: { kind: "selector" },
            fallbacks: [null, { kind: "selector", value: "#fallback" }],
          },
        },
      },
    });

    expect(result.candidates.map((item) => item.source)).toEqual([
      "story_target",
      "sidecar_fallback",
    ]);
    expect(result.diagnostics).toEqual([
      { source: "sidecar_primary", fallbackIndex: null, reason: "malformed_target" },
      { source: "sidecar_fallback", fallbackIndex: 0, reason: "malformed_target" },
    ]);
  });

  it("falls back to legacy eligibility for missing steps and unknown versions", () => {
    const missing = buildRuntimeTargetCandidates({
      command: command({ kind: "selector", value: "#story" }),
      sidecar: { version: 1, steps: {} },
    });
    const unknown = buildRuntimeTargetCandidates({
      command: command({ kind: "selector", value: "#story" }),
      sidecar: { version: 7, steps: {} },
    });

    expect(missing).toMatchObject({ eligible: false, diagnostics: [] });
    expect(unknown).toMatchObject({
      eligible: false,
      diagnostics: [
        { source: "sidecar", fallbackIndex: null, reason: "unsupported_sidecar_version" },
      ],
    });
  });

  it("defaults to shadow only on macOS and accepts explicit rollout modes", () => {
    expect(runtimeTargetCandidatesMode(undefined, "darwin")).toBe("shadow");
    expect(runtimeTargetCandidatesMode(undefined, "win32")).toBe("off");
    expect(runtimeTargetCandidatesMode("enforce", "win32")).toBe("enforce");
    expect(runtimeTargetCandidatesMode("future", "darwin")).toBe("shadow");
  });
});

describe("runtime target candidate resolution", () => {
  const candidates = buildRuntimeTargetCandidates({
    command: command({ kind: "selector", value: "#story" }),
    sidecar: {
      version: 1,
      steps: {
        "step-1": {
          primary: { kind: "selector", value: "#primary" },
          fallbacks: [{ kind: "selector", value: "#fallback" }],
        },
      },
    },
  }).candidates;

  it("selects the first ready candidate and preserves ordered failed attempts", async () => {
    const attempted: string[] = [];
    const result = await resolveRuntimeTargetCandidates({
      candidates,
      timeoutMs: 1_000,
      wait: async () => true,
      observe: async () => ({ status: "not_ready", reason: "not_found" }),
      attempt: async (candidate) => {
        attempted.push(candidate.source);
        if (candidate.source !== "sidecar_fallback") throw failure("not_found");
        return { target: target("fallback"), scrollTiming: null };
      },
    });

    expect(attempted).toEqual(["sidecar_primary", "story_target", "sidecar_fallback"]);
    expect(result.candidate).toMatchObject({ source: "sidecar_fallback", fallbackIndex: 0 });
    expect(result.attempts.map((attempt) => attempt.source)).toEqual([
      "sidecar_primary",
      "story_target",
    ]);
  });

  it("restarts authored priority when primary becomes ready during fallback resolution", async () => {
    let primaryAttempts = 0;
    const result = await resolveRuntimeTargetCandidates({
      candidates,
      timeoutMs: 1_000,
      wait: async () => true,
      observe: async (candidate) =>
        candidate.source === "sidecar_primary"
          ? { status: "ready", target: target("primary") }
          : { status: "not_ready", reason: "not_found" },
      attempt: async (candidate) => {
        if (candidate.source === "sidecar_primary") {
          primaryAttempts += 1;
          if (primaryAttempts === 1) throw failure("not_found");
          return { target: target("primary"), scrollTiming: null };
        }
        if (candidate.source === "story_target") throw failure("not_found");
        return { target: target("fallback"), scrollTiming: null };
      },
    });

    expect(result.candidate.source).toBe("sidecar_primary");
    expect(primaryAttempts).toBe(2);
  });

  it("shares one active timeout across every candidate", async () => {
    const waited: number[] = [];
    await expect(
      resolveRuntimeTargetCandidates({
        candidates,
        timeoutMs: 100,
        candidateAttemptMs: 100,
        pollIntervalMs: 10,
        wait: async (durationMs) => {
          waited.push(durationMs);
          return true;
        },
        observe: async () => ({ status: "not_ready", reason: "not_found" }),
        attempt: async (_candidate, _timeoutMs, wait) => {
          await wait(80);
          throw failure("not_found");
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeTargetCandidatesExhaustedError);

    expect(waited.reduce((total, durationMs) => total + durationMs, 0)).toBe(100);
  });

  it("throws one sanitized ordered exhaustion error", async () => {
    let thrown: unknown;
    try {
      await resolveRuntimeTargetCandidates({
        candidates,
        timeoutMs: 10,
        wait: async () => true,
        observe: async () => ({ status: "not_ready", reason: "not_found" }),
        attempt: async (candidate) => {
          throw failure(candidate.source === "sidecar_primary" ? "hidden" : "not_found");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeTargetCandidatesExhaustedError);
    const error = thrown as RuntimeTargetCandidatesExhaustedError;
    expect(error.attempts.map(({ source, reason }) => ({ source, reason }))).toEqual([
      { source: "sidecar_primary", reason: "hidden" },
      { source: "story_target", reason: "not_found" },
      { source: "sidecar_fallback", reason: "not_found" },
    ]);
    expect(JSON.stringify(error.diagnostics)).not.toContain("#primary");
    expect(JSON.stringify(error.diagnostics)).not.toContain("#fallback");
  });

  it("does not consume or translate cancellation errors", async () => {
    const cancellation = new Error("cancelled");
    await expect(
      resolveRuntimeTargetCandidates({
        candidates: candidates.slice(0, 1),
        timeoutMs: 100,
        wait: vi.fn(async () => true),
        observe: async () => ({ status: "not_ready", reason: "not_found" }),
        attempt: async () => {
          throw cancellation;
        },
      }),
    ).rejects.toBe(cancellation);
  });
});

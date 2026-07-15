import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import slugify from "@sindresorhus/slugify";
import { app, BrowserWindow, type WebContents } from "electron";
import type {
  FrameSyncDegradedReason,
  FrameSyncOutcome,
  RecordedInputLandmarkKind,
} from "../action-landmarks";
import {
  type ActionCursorTiming,
  type ActionInputTiming,
  type ActionScrollTiming,
  type ActionTarget,
  type ActionTimelineEvent,
  actionsSidecarPath,
  actionTimelineEventFromStep,
  deriveActionCaptureRect,
  recordingActionsFromSession,
  validateRecordingActionsV3,
  writeActionsSidecarAtomic,
} from "../action-timeline";
import { cursorCommandPolicy, resolveCursorCommandPolicy } from "../cursor-policy";
import { resolveCursorSyncMode } from "../cursor-sync-mode";
import {
  type CursorActionTimingPlan,
  type CursorTimingSize,
  cursorPointForTarget,
  cursorTimelineTimingFromPlan,
  initialCursorPoint,
  normalizeCursorTimingSize,
  planCursorActionTiming,
  sampleCursorMotionPath,
  targetCenterDeltaPx,
} from "../cursor-timing";
import {
  DragExecutionError,
  dragExecutionMode,
  executeDragPlan,
  planDragExecution,
} from "../drag-execution";
import {
  executeFileUpload,
  FileUploadError,
  observeUploadInput,
  type ResolvedUploadAsset,
  resolveUploadAsset,
  uploadExecutionMode,
} from "../file-upload";
import {
  InteractionReadinessError,
  observeInteractionTarget,
  waitForInteractionReadiness,
} from "../interaction-readiness";
import { readJson, writeJsonAtomic } from "../json-store";
import { sameNavigationUrl } from "../navigation-url";
import { userDataPath } from "../paths";
import {
  disposeRecordingCheckpoints,
  RecordingCheckpointError,
  recordingCheckpointsForSession,
} from "../recording-checkpoints";
import { recordingLifecycle } from "../recording-lifecycle";
import { recordEngineLog } from "../recording-observability";
import { recordingOutcomeMode } from "../recording-outcome";
import { RecordingPauseCancelledError } from "../recording-pause-gate";
import {
  type RecordingRepairPhase,
  type RepairRequiredEvent,
  recordingRepairController,
  recordingRepairMode,
} from "../recording-repair";
import {
  buildRuntimeTargetCandidates,
  RuntimeTargetAttemptError,
  type RuntimeTargetCandidate,
  type RuntimeTargetCandidateSet,
  RuntimeTargetCandidatesExhaustedError,
  type RuntimeTargetEndpointKey,
  type RuntimeTargetResolution,
  type RuntimeTargetSidecar,
  resolveRuntimeTargetCandidates,
  runtimeTargetCandidatesMode,
} from "../runtime-target-candidates";
import {
  setSimulatorTargetValueIncrementalScript,
  setSimulatorTargetValueScript,
  simulatorTypeProbeScript,
} from "../simulator-dom";
import {
  ensureTargetVisible,
  executeControlledScroll,
  TargetVisibilityPhaseError,
} from "../smooth-scroll";
import {
  type ParsedCommand,
  type ParsedCommandSceneContext,
  parsedCommands,
  parseStorySource,
} from "../story-parser";
import {
  authorSession,
  captureAutomationRecordingTail,
  ensureRecordingFramesCoverElapsedTime,
  invalidateAuthorPreviewPaintForContents,
  normalizedTargetRecord,
  recordingCaptureStateSnapshot,
  recordingFrameCommitBudgetMs,
  requestRecordingFrameCommit,
  storyBrowserExecutionProfile,
  targetsPathFor,
} from "./capture-preview";
import { sidecarPath } from "./post-production";
import { pauseRecording, resumeRecording, stopRecording } from "./recording";
import {
  authorPreviewSessions,
  channelIdFrom,
  type DryRunSession,
  type DryRunStep,
  dryRunSessions,
  EXPORTS_DIRNAME,
  hostLog,
  type ParsedCommandResult,
  type RecordingSession,
  recordingSessions,
  resolveElementTarget,
  type SimulatorStepFrame,
  type StoryBrowserExecutionProfile,
  type StoryBrowserRunExitReason,
  type StoryBrowserRunOptions,
  sendChannel,
  simulatorSessions,
  storyAppUrl,
  storyHash,
  targetLabel,
  targetSelector,
  waitMs,
} from "./shared";

const FALLBACK_TARGET_VERBS = ["click", "type", "hover", "select", "upload"];
const CAPTURE_MUTATION_VERBS = ["navigate", "scroll", "click", "type", "hover", "select", "upload"];
const FRAME_SYNC_FALLBACK_TIMEOUT_MS = 500;
const MAX_TARGET_DETACH_RETRIES = 2;
const TARGET_DETACH_RETRY_DELAY_MS = 100;
const TYPE_PROBE_HASH_SALT = randomUUID();

function typeProbeEnabled(executionProfile: StoryBrowserExecutionProfile): boolean {
  return (
    executionProfile.captureRecordingFrames && process.env.STORYCAPTURE_DEBUG_TYPE_PROBE === "1"
  );
}

async function logTypeProbe(
  contents: WebContents,
  command: ParsedCommand,
  phase: "before_write" | "after_write" | "after_render_turn",
): Promise<void> {
  try {
    const probe = await contents.executeJavaScript(
      simulatorTypeProbeScript(
        command.target,
        command.target_nth,
        targetSelector(command.target),
        TYPE_PROBE_HASH_SALT,
      ),
    );
    void hostLog("info", "automation_type_probe", { phase, ...probe });
  } catch (error) {
    void hostLog("warn", "automation_type_probe_failed", {
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function requestFrameCommitOutcome(
  requestFrameCommit: (() => Promise<FrameSyncOutcome>) | undefined,
): Promise<FrameSyncOutcome | null> {
  if (!requestFrameCommit) return null;
  try {
    return await requestFrameCommit();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { recordingReasonCode?: unknown }).recordingReasonCode === "readiness_failed"
    ) {
      throw error;
    }
    return { status: "degraded", reason: "frame_capture_failed" };
  }
}

export function commandMutatesCapturedPage(command: ParsedCommand): boolean {
  return CAPTURE_MUTATION_VERBS.includes(command.verb);
}

function automationFailureDiagnostics(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    phase?: unknown;
    reason?: unknown;
    diagnostics?: unknown;
  };
  if (typeof value.reason !== "string" && typeof value.phase !== "string") return null;
  return {
    phase: typeof value.phase === "string" ? value.phase : "readiness",
    reason: typeof value.reason === "string" ? value.reason : "unknown",
    ...(value.diagnostics && typeof value.diagnostics === "object"
      ? { context: value.diagnostics }
      : {}),
  };
}

function captureStateSnapshot(
  snapshot: (() => Record<string, unknown>) | undefined,
): Record<string, unknown> {
  if (!snapshot) return {};
  try {
    return snapshot();
  } catch {
    return { capture_state: "unavailable" };
  }
}

function logFrameSyncDegradation(input: {
  options: StoryBrowserRunOptions;
  recordingSessionId?: string;
  command: ParsedCommand;
  ordinal: number;
  barrier: "cursor_arrival" | "pre_input";
  reason: string;
}): void {
  const { options, recordingSessionId, command, ordinal, barrier, reason } = input;
  if (recordingSessionId) {
    void recordEngineLog({
      level: "warn",
      event: "recording.readiness.degraded",
      context: {
        session_id: recordingSessionId,
        step_id: command.step_id ?? undefined,
        ordinal,
        phase: barrier,
        reason_code: reason,
      },
      details: { verb: command.verb },
    });
    return;
  }
  void hostLog("warn", "automation_frame_sync_degraded_before_input", {
    ordinal,
    step_id: command.step_id ?? null,
    verb: command.verb,
    barrier,
    reason,
    ...captureStateSnapshot(options.captureStateSnapshot),
  });
}

function recordingFrameClockMs(session: RecordingSession): number {
  return Math.max(0, Math.round(session.mediaClock.snapshot().durationUs / 1000));
}

async function waitForRecordingDelay(
  pauseGate: StoryBrowserRunOptions["pauseGate"],
  durationMs: number,
): Promise<void> {
  if (!pauseGate && durationMs <= 0) return;
  const completed = pauseGate ? await pauseGate.waitForDelay(durationMs) : await waitMs(durationMs);
  if (completed === false) throw new RecordingPauseCancelledError();
}

export async function executeParsedCommand(
  contents: WebContents,
  command: ParsedCommand,
  projectFolder: string,
  options: {
    executionProfile?: StoryBrowserExecutionProfile;
    resolvedTarget?: ActionTarget | null;
    pauseGate?: StoryBrowserRunOptions["pauseGate"];
    shouldCancel?: () => boolean;
    onInputSideEffect?: (kind: RecordedInputLandmarkKind) => void;
    beforeInputSideEffect?: () => void;
    resolvedSecondaryTarget?: ActionTarget | null;
    validateSecondaryTarget?: () => Promise<boolean>;
    onCursorSample?: (point: { x: number; y: number }) => void;
    resolvedUploadAsset?: ResolvedUploadAsset | null;
  } = {},
): Promise<RuntimeParsedCommandResult> {
  const executionProfile = options.executionProfile ?? storyBrowserExecutionProfile();
  if (command.verb === "navigate" && command.url) {
    if (sameNavigationUrl(contents.getURL(), command.url)) return {};
    await contents.loadURL(command.url);
    return {};
  }
  if (command.verb === "wait") {
    await waitForRecordingDelay(options.pauseGate, Math.min(command.duration_ms ?? 0, 30_000));
    return {};
  }
  if (command.verb === "text-overlay") {
    await waitForRecordingDelay(options.pauseGate, command.duration_ms ?? 0);
    return {};
  }
  if (command.verb === "pause") return {};
  if (command.verb === "scroll") {
    const direction = command.direction ?? "down";
    if (!["up", "down", "left", "right"].includes(direction)) {
      throw new Error(`unsupported scroll direction: ${direction}`);
    }
    const amount = Number(command.amount ?? 500);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`invalid scroll amount: ${command.amount ?? 500}`);
    }
    await executeControlledScroll({
      contents,
      target: command.target,
      targetNth: command.target_nth,
      selector: targetSelector(command.target),
      direction: direction as "up" | "down" | "left" | "right",
      amount,
      unit: command.unit ?? "px",
      wait: async (durationMs) => {
        if (options.pauseGate) return options.pauseGate.waitForDelay(durationMs);
        await waitMs(durationMs);
        return true;
      },
      shouldCancel: options.shouldCancel,
    });
    return {};
  }
  if (command.verb === "drag") {
    if (!options.resolvedTarget || !options.resolvedSecondaryTarget) {
      throw new DragExecutionError("target_missing_before_input", false);
    }
    const recordingFps =
      (executionProfile as StoryBrowserExecutionProfile & { recordingFps?: number }).recordingFps ??
      30;
    const plan = planDragExecution({
      source: options.resolvedTarget,
      destination: options.resolvedSecondaryTarget,
      fps: recordingFps,
      motionPreset: executionProfile.cursorMotionPreset ?? "natural",
      eventKey: `${command.step_id ?? "drag"}:${options.resolvedTarget.center.x}:${options.resolvedSecondaryTarget.center.x}`,
    });
    const result = await executeDragPlan({
      plan,
      sendInputEvent: (event) => contents.sendInputEvent(event as never),
      wait: async (durationMs) => {
        await waitForRecordingDelay(options.pauseGate, durationMs);
        return true;
      },
      shouldCancel: options.shouldCancel,
      beforeInputSideEffect: options.beforeInputSideEffect,
      onInputSideEffect: options.onInputSideEffect,
      onCursorSample: options.onCursorSample,
      beforePressedPath: options.validateSecondaryTarget,
    });
    return { ...result, dragSamples: plan.samples };
  }
  if (command.verb === "upload") {
    if (!options.resolvedTarget || !options.resolvedUploadAsset) {
      throw new Error("upload target and asset must be resolved before execution");
    }
    return executeFileUpload({
      contents,
      targetDescriptor: command.target,
      targetNth: command.target_nth,
      selector: targetSelector(command.target),
      resolvedTarget: options.resolvedTarget,
      asset: options.resolvedUploadAsset,
      shouldCancel: options.shouldCancel,
      beforeInputSideEffect: options.beforeInputSideEffect,
      onInputSideEffect: (kind) => options.onInputSideEffect?.(kind),
    });
  }

  const target = command.target
    ? (options.resolvedTarget ??
      (await resolveElementTarget(contents, command.target, command.target_nth)))
    : null;
  const center = target?.center ?? null;
  if (
    (command.verb === "wait-for-visible" || command.verb === "assert-visible") &&
    command.target &&
    target
  ) {
    return { cursor: target.center, target };
  }
  if ((command.verb === "wait-for" || command.verb === "assert") && command.target) {
    let remainingMs = Math.min(Number(command.timeout_ms ?? 5_000), 30_000);
    let found = target;
    while (!found && remainingMs > 0) {
      const delayMs = Math.min(100, remainingMs);
      await waitForRecordingDelay(options.pauseGate, delayMs);
      remainingMs -= delayMs;
      found = await resolveElementTarget(contents, command.target, command.target_nth);
    }
    if (!found)
      throw new Error(`target not found for ${command.verb}: ${selectorSummary(command.target)}`);
    return { cursor: found.center, target: found };
  }
  if (commandSupportsFallback(command) && !center) {
    throw new Error(`target not found for ${command.verb}: ${selectorSummary(command.target)}`);
  }
  if ((command.verb === "click" || command.verb === "hover") && center) {
    if (command.verb === "hover") options.beforeInputSideEffect?.();
    contents.sendInputEvent({ type: "mouseMove", x: center.x, y: center.y });
    if (command.verb === "click") {
      options.beforeInputSideEffect?.();
      options.onInputSideEffect?.("down");
      contents.sendInputEvent({
        type: "mouseDown",
        x: center.x,
        y: center.y,
        button: "left",
        clickCount: 1,
      });
      options.onInputSideEffect?.("up");
      contents.sendInputEvent({
        type: "mouseUp",
        x: center.x,
        y: center.y,
        button: "left",
        clickCount: 1,
      });
      options.onInputSideEffect?.("action");
    } else {
      options.onInputSideEffect?.("action");
    }
    return {
      cursor: center,
      target,
      pointer: command.verb === "click" ? { button: "left", effect: "click" } : null,
    };
  }
  if ((command.verb === "type" || command.verb === "select") && center) {
    options.beforeInputSideEffect?.();
    options.onInputSideEffect?.("down");
    contents.sendInputEvent({
      type: "mouseDown",
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    });
    options.onInputSideEffect?.("up");
    contents.sendInputEvent({
      type: "mouseUp",
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    });
    const value = command.verb === "type" ? (command.text ?? "") : (command.value ?? "");
    const valueScript =
      command.verb === "type" && executionProfile.typingMode === "incremental"
        ? setSimulatorTargetValueIncrementalScript(
            command.target,
            value,
            command.target_nth,
            targetSelector(command.target),
            35,
          )
        : setSimulatorTargetValueScript(
            command.target,
            value,
            command.target_nth,
            targetSelector(command.target),
          );
    const shouldProbeType = command.verb === "type" && typeProbeEnabled(executionProfile);
    if (shouldProbeType) await logTypeProbe(contents, command, "before_write");
    options.onInputSideEffect?.("text_start");
    const didWrite = await contents.executeJavaScript(valueScript);
    options.onInputSideEffect?.("text_end");
    options.onInputSideEffect?.("action");
    if (shouldProbeType) {
      await logTypeProbe(contents, command, "after_write");
      await waitMs(0);
      await logTypeProbe(contents, command, "after_render_turn");
    }
    if (!didWrite) {
      throw new Error(
        `target is not editable for ${command.verb}: ${selectorSummary(command.target)}`,
      );
    }
    return { cursor: center, target };
  }
  if (command.verb === "screenshot") {
    const image = await contents.capturePage();
    const exportsDir = path.join(projectFolder, EXPORTS_DIRNAME);
    await fs.mkdir(exportsDir, { recursive: true });
    const safeName =
      slugify(command.name ?? `screenshot-${Date.now()}`) || `screenshot-${Date.now()}`;
    const screenshotPath = path.join(exportsDir, `${safeName}.png`);
    await fs.writeFile(screenshotPath, image.toPNG());
    return { screenshotPath };
  }
  return { cursor: center, target };
}

export async function ensureStoryInitialUrl(
  contents: WebContents,
  storySource: string,
): Promise<void> {
  const appUrl = storyAppUrl(storySource);
  if (!appUrl || !/^https?:\/\//i.test(appUrl)) return;
  const currentUrl = contents.getURL();
  const shouldNavigate = (() => {
    if (!currentUrl || currentUrl === "about:blank") return true;
    try {
      return !sameNavigationUrl(currentUrl, appUrl);
    } catch {
      return true;
    }
  })();
  if (shouldNavigate) {
    await contents.loadURL(appUrl);
  }
}

export function liveSceneEntryUrlForRepair(
  commands: ParsedCommand[],
  sceneId: string,
  storySource: string,
): string | null {
  const first = commands.find((command) => command.scene_id === sceneId);
  const candidate =
    first?.verb === "navigate" && first.url
      ? first.url
      : first?.scene_ordinal === 1
        ? storyAppUrl(storySource)
        : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function writePngAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, bytes);
  await fs.rename(tempPath, filePath);
}

async function captureFailureFrameBestEffort(
  contents: WebContents,
  frameDir: string | null | undefined,
  ordinal: number,
): Promise<string | null> {
  if (!frameDir) return null;
  try {
    await fs.mkdir(frameDir, { recursive: true });
    const framePath = path.join(frameDir, `failure-step-${String(ordinal).padStart(4, "0")}.png`);
    const image = await contents.capturePage();
    if (image.isEmpty()) return null;
    await writePngAtomic(framePath, image.toPNG());
    return framePath;
  } catch (captureError) {
    void hostLog("warn", "automation_failure_screenshot_failed", {
      ordinal,
      error: captureError instanceof Error ? captureError.message : String(captureError),
    });
    return null;
  }
}

export async function captureStoryFrame(
  contents: WebContents,
  frameDir: string,
  ordinal: number,
  existingPath?: string | null,
): Promise<string> {
  if (existingPath) return existingPath;
  const framePath = path.join(frameDir, `step-${String(ordinal).padStart(4, "0")}.png`);
  const image = await contents.capturePage();
  if (image.isEmpty()) throw new Error(`captured empty browser frame for step ${ordinal}`);
  await writePngAtomic(framePath, image.toPNG());
  return framePath;
}

export function simulatorFrameFromResult(
  ordinal: number,
  command: ParsedCommand | undefined,
  targets: {
    version: number;
    steps: Record<string, { primary?: unknown; fallbacks?: unknown[] }>;
  },
  result: ParsedCommandResult,
  screenshotPath: string | null,
  durationMs: number,
): SimulatorStepFrame {
  const stepTargets = command?.step_id ? targets.steps[command.step_id] : null;
  const fallback = Array.isArray(stepTargets?.fallbacks) ? stepTargets.fallbacks[0] : null;
  const primary = stepTargets?.primary ?? command?.target ?? null;
  const matchKind = commandSupportsFallback(command)
    ? fallback
      ? "fuzzy"
      : result.cursor || primary
        ? "primary"
        : "none"
    : "none";
  return {
    ordinal,
    screenshot_path: screenshotPath,
    cursor_xy: [result.cursor?.x ?? 0, result.cursor?.y ?? 0],
    matched_selector: matchKind === "fuzzy" ? selectorSummary(fallback) : selectorSummary(primary),
    matched_bbox: matchKind === "none" ? null : (result.target?.bounds ?? null),
    match_kind: matchKind,
    duration_ms: durationMs,
  };
}

export function commandGetsPreActionPacing(command: ParsedCommand): boolean {
  return cursorCommandPolicy(command.verb).contributesActionEvent;
}

async function resolveCommandTarget(
  contents: WebContents,
  command: ParsedCommand,
): Promise<ActionTarget | null> {
  if (!command.target) return null;
  return resolveElementTarget(contents, command.target, command.target_nth);
}

function commandRequiresEnabledTarget(command: ParsedCommand): boolean {
  return (
    command.verb === "click" ||
    command.verb === "type" ||
    command.verb === "select" ||
    command.verb === "drag"
  );
}

async function observeReadyCommandTarget(options: StoryBrowserRunOptions, command: ParsedCommand) {
  if (!command.target) return { status: "not_ready", reason: "not_found" } as const;
  if (command.verb === "upload") {
    return observeUploadInput({
      contents: options.contents,
      target: command.target,
      targetNth: command.target_nth,
      selector: targetSelector(command.target),
      label: targetLabel(command.target),
    });
  }
  return observeInteractionTarget({
    contents: options.contents,
    target: command.target,
    targetNth: command.target_nth,
    selector: targetSelector(command.target),
    label: targetLabel(command.target),
    requireEnabled: commandRequiresEnabledTarget(command),
  });
}

async function resolveReadyCommandTarget(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
): Promise<ActionTarget> {
  const result = await waitForInteractionReadiness({
    observe: () => observeReadyCommandTarget(options, command),
    wait: async (durationMs) => {
      if (options.pauseGate) {
        if (!(await options.pauseGate.waitForDelay(durationMs))) {
          throw new RecordingPauseCancelledError();
        }
        return true;
      }
      await waitMs(durationMs);
      return true;
    },
    timeoutMs: Math.min(Number(command.timeout_ms ?? 30_000), 30_000),
    stabilityThresholdPx: 1,
  });
  return result.target;
}

function commandUsesVisibilityPipeline(command: ParsedCommand): boolean {
  return (
    (command.verb !== "drag" && commandGetsPreActionPacing(command)) ||
    command.verb === "wait-for-visible" ||
    command.verb === "assert-visible"
  );
}

async function ensureReadyCommandTarget(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  recordingClockMs: () => number,
  timeoutMs = Math.min(Number(command.timeout_ms ?? 30_000), 30_000),
  waitOverride?: (durationMs: number) => Promise<boolean | undefined>,
): Promise<{
  target: ActionTarget;
  scrollTiming: ActionScrollTiming | null;
  diagnostics?: RuntimeTargetResolution["diagnostics"];
}> {
  const result = await ensureTargetVisible({
    contents: options.contents,
    target: command.target,
    targetNth: command.target_nth,
    selector: targetSelector(command.target),
    observe: () => observeReadyCommandTarget(options, command),
    wait:
      waitOverride ??
      (async (durationMs) => {
        if (options.pauseGate) {
          if (!(await options.pauseGate.waitForDelay(durationMs))) {
            throw new RecordingPauseCancelledError();
          }
          return true;
        }
        await waitMs(durationMs);
        return true;
      }),
    shouldCancel: () => {
      if (options.shouldCancel?.()) throw new RecordingPauseCancelledError();
      return false;
    },
    now: recordingClockMs,
    timeoutMs,
  });
  return {
    target: result.target,
    diagnostics: result.diagnostics,
    scrollTiming: result.scrollTiming
      ? {
          start_ms: result.scrollTiming.startedAtMs,
          end_ms: result.scrollTiming.endedAtMs,
          duration_ms: result.scrollTiming.durationMs,
        }
      : null,
  };
}

async function recoverDetachedCommandTarget(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  ordinal: number,
  recordingClockMs: () => number,
): Promise<{ target: ActionTarget; scrollTiming: ActionScrollTiming | null }> {
  const budgetMs = Math.min(Number(command.timeout_ms ?? 30_000), 30_000);
  const startedAtMs = recordingClockMs();
  let lastError: TargetVisibilityPhaseError | null = null;

  for (let attempt = 1; attempt <= MAX_TARGET_DETACH_RETRIES + 1; attempt += 1) {
    if (options.shouldCancel?.()) throw new RecordingPauseCancelledError();
    const elapsedMs = Math.max(0, recordingClockMs() - startedAtMs);
    const remainingMs = Math.max(0, budgetMs - elapsedMs);
    if (attempt > 1 && remainingMs <= 0) break;
    try {
      return await ensureReadyCommandTarget(options, command, recordingClockMs, remainingMs);
    } catch (error) {
      if (!(error instanceof TargetVisibilityPhaseError) || error.reason !== "detached")
        throw error;
      lastError = error;
      if (options.recordingSessionId) {
        void recordEngineLog({
          level: "warn",
          event: "recording.target.retry_scheduled",
          context: {
            session_id: options.recordingSessionId,
            step_id: command.step_id ?? undefined,
            ordinal,
            phase: error.phase,
            reason_code: error.reason,
          },
          details: {
            attempt,
            elapsed_ms: elapsedMs,
            budget_ms: budgetMs,
            verb: command.verb,
          },
        });
      } else {
        void hostLog("warn", "automation_target_recovery", {
          ordinal,
          step_id: command.step_id ?? null,
          verb: command.verb,
          phase: error.phase,
          reason: error.reason,
          attempt,
          elapsed_ms: elapsedMs,
          budget_ms: budgetMs,
          target_label: targetLabel(command.target),
          target_bounds: error.diagnostics?.bounds ?? null,
        });
      }
      if (options.shouldCancel?.()) throw new RecordingPauseCancelledError();
      if (attempt <= MAX_TARGET_DETACH_RETRIES) {
        await waitForRecordingDelay(
          options.pauseGate,
          Math.min(TARGET_DETACH_RETRY_DELAY_MS, remainingMs),
        );
      }
    }
  }

  if (lastError) {
    const elapsedMs = Math.max(0, recordingClockMs() - startedAtMs);
    const exhausted = new TargetVisibilityPhaseError(
      lastError.phase,
      lastError.reason,
      lastError.diagnostics,
    );
    exhausted.message =
      `interaction target detached after ${MAX_TARGET_DETACH_RETRIES + 1} attempts ` +
      `(last phase: ${lastError.phase}, elapsed: ${elapsedMs}/${budgetMs}ms)`;
    throw exhausted;
  }
  throw new InteractionReadinessError("detached");
}

interface ResolvedCommandVisibility {
  target: ActionTarget;
  scrollTiming: ActionScrollTiming | null;
  command: ParsedCommand;
  runtimeTarget: RuntimeTargetResolution | null;
}

type RuntimeParsedCommandResult = ParsedCommandResult & {
  runtimeTarget?: RuntimeTargetResolution;
  runtimeTargets?: {
    source: RuntimeTargetResolution;
    destination: RuntimeTargetResolution;
  };
  source?: ActionTarget;
  dragSamples?: Array<{ x: number; y: number; elapsedMs: number }>;
  uploadAsset?: {
    projectRelativePath: string;
    basename: string;
    byteSize: number;
  };
};

interface ResolvedDragEndpoints {
  source: RuntimeTargetResolution;
  destination: RuntimeTargetResolution;
}

interface RecordingCheckpointRunOptions extends StoryBrowserRunOptions {
  recordingCheckpointSessionId?: string | null;
  recordingMediaClockSnapshot?: () => ReturnType<RecordingSession["mediaClock"]["snapshot"]>;
  captureSceneTail?: () => Promise<void>;
  recordingRepairSessionId?: string | null;
  onRepairRequired?: (event: RepairRequiredEvent) => void;
  pauseRecordingForRepair?: () => Promise<void>;
  resumeRecordingForRepair?: () => Promise<void>;
  canRestoreSceneEntry?: (sceneId: string) => boolean;
  restoreSceneEntry?: (sceneId: string) => Promise<boolean>;
}

function requiredSceneContext(command: ParsedCommand): ParsedCommandSceneContext {
  if (
    !command.scene_id ||
    !command.scene_name ||
    !Number.isSafeInteger(command.scene_ordinal) ||
    Number(command.scene_ordinal) <= 0 ||
    !Number.isSafeInteger(command.step_ordinal) ||
    Number(command.step_ordinal) <= 0
  ) {
    throw new RecordingCheckpointError("scene_context_missing");
  }
  return {
    scene_id: command.scene_id,
    scene_name: command.scene_name,
    scene_ordinal: Number(command.scene_ordinal),
    step_ordinal: Number(command.step_ordinal),
  };
}

function commandForRuntimeCandidate(
  command: ParsedCommand,
  candidate: RuntimeTargetCandidate,
): ParsedCommand {
  return {
    ...command,
    target: candidate.target,
    ...(candidate.targetNth == null
      ? { target_nth: undefined }
      : { target_nth: candidate.targetNth }),
  };
}

function dragEndpointCommand(
  command: ParsedCommand,
  endpoint: Exclude<RuntimeTargetEndpointKey, "target">,
  candidate?: RuntimeTargetCandidate,
): ParsedCommand {
  const target = candidate?.target ?? command[endpoint];
  const targetNth =
    candidate?.targetNth ?? (endpoint === "from" ? command.from_nth : command.to_nth);
  return {
    ...command,
    verb: endpoint === "from" ? "click" : "hover",
    target,
    target_nth: targetNth,
  };
}

function runtimeTargetAttemptError(error: unknown): RuntimeTargetAttemptError | null {
  if (error instanceof InteractionReadinessError) {
    return new RuntimeTargetAttemptError(error.reason, error.diagnostics);
  }
  if (error instanceof TargetVisibilityPhaseError) {
    return new RuntimeTargetAttemptError(error.reason, error.diagnostics);
  }
  return null;
}

async function waitForRuntimeTargetDelay(
  options: StoryBrowserRunOptions,
  durationMs: number,
): Promise<boolean> {
  if (options.shouldCancel?.()) throw new RecordingPauseCancelledError();
  if (options.pauseGate) {
    if (!(await options.pauseGate.waitForDelay(durationMs))) {
      throw new RecordingPauseCancelledError();
    }
    return true;
  }
  await waitMs(durationMs);
  return true;
}

async function resolveRuntimeTarget(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  candidateSet: RuntimeTargetCandidateSet,
  recordingClockMs: () => number,
  timeoutMs: number,
): Promise<RuntimeTargetResolution> {
  return resolveRuntimeTargetCandidates({
    candidates: candidateSet.candidates,
    timeoutMs,
    wait: (durationMs) => waitForRuntimeTargetDelay(options, durationMs),
    observe: (candidate) =>
      observeReadyCommandTarget(options, commandForRuntimeCandidate(command, candidate)),
    attempt: async (candidate, attemptTimeoutMs, wait) => {
      try {
        const result = await ensureReadyCommandTarget(
          options,
          commandForRuntimeCandidate(command, candidate),
          recordingClockMs,
          attemptTimeoutMs,
          wait,
        );
        return {
          target: result.target,
          diagnostics: result.diagnostics,
          scrollTiming: result.scrollTiming,
        };
      } catch (error) {
        const readinessError = runtimeTargetAttemptError(error);
        if (readinessError) throw readinessError;
        throw error;
      }
    },
  });
}

async function resolveDragEndpoint(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  endpoint: Exclude<RuntimeTargetEndpointKey, "target">,
  ordinal: number,
  recordingClockMs: () => number,
  timeoutMs: number,
): Promise<RuntimeTargetResolution> {
  const endpointCommand = dragEndpointCommand(command, endpoint);
  const candidateSet = buildRuntimeTargetCandidates({
    command,
    sidecar: options.targets,
    endpointKey: endpoint,
  });
  const mode = runtimeTargetCandidatesMode();
  if (candidateSet.diagnostics.length > 0) {
    if (options.recordingSessionId) {
      void recordEngineLog({
        level: "warn",
        event: "recording.target.candidate_validation_failed",
        context: {
          session_id: options.recordingSessionId,
          step_id: command.step_id ?? undefined,
          ordinal,
          phase: `drag_${endpoint}_candidate_validation`,
          reason_code: "invalid_sidecar_candidate",
        },
        details: { endpoint, diagnostic_count: candidateSet.diagnostics.length },
      });
    } else {
      void hostLog("warn", "runtime_drag_endpoint_diagnostic", {
        ordinal,
        step_id: command.step_id ?? null,
        endpoint,
        diagnostics: candidateSet.diagnostics,
      });
    }
  }

  if (!candidateSet.eligible || mode === "off") {
    const legacy = await recoverDetachedCommandTarget(
      options,
      { ...endpointCommand, timeout_ms: timeoutMs },
      ordinal,
      recordingClockMs,
    );
    const resolved = legacyRuntimeTarget(candidateSet, legacy.target, legacy.scrollTiming);
    if (!resolved) throw new RuntimeTargetCandidatesExhaustedError([]);
    return resolved;
  }

  if (mode === "shadow") {
    const legacy = await recoverDetachedCommandTarget(
      options,
      { ...endpointCommand, timeout_ms: timeoutMs },
      ordinal,
      recordingClockMs,
    );
    const proposed = await probeRuntimeTarget(options, endpointCommand, candidateSet);
    const actual = legacyRuntimeTarget(candidateSet, legacy.target, legacy.scrollTiming);
    const diverged = Boolean(proposed && proposed.candidate.key !== actual?.candidate.key);
    if (options.recordingSessionId) {
      void recordEngineLog({
        event: "recording.drag.shadow_compared",
        context: {
          session_id: options.recordingSessionId,
          step_id: command.step_id ?? undefined,
          ordinal,
          phase: endpoint,
        },
        details: {
          endpoint,
          actual_source: actual?.candidate.source ?? "story_target",
          proposed_source: proposed?.candidate.source ?? null,
          proposed_fallback_index: proposed?.candidate.fallbackIndex ?? null,
          attempt_count: proposed?.attempts.length ?? 0,
          diverged,
        },
      });
    } else {
      void hostLog("info", "runtime_drag_endpoint_shadow", {
        ordinal,
        step_id: command.step_id ?? null,
        endpoint,
        actual_source: actual?.candidate.source ?? "story_target",
        proposed_source: proposed?.candidate.source ?? null,
        diverged,
        attempted: proposed?.attempts ?? [],
      });
    }
    if (!actual) throw new RuntimeTargetCandidatesExhaustedError([]);
    return actual;
  }

  return resolveRuntimeTarget(options, endpointCommand, candidateSet, recordingClockMs, timeoutMs);
}

async function resolveDragEndpoints(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  ordinal: number,
  recordingClockMs: () => number,
): Promise<ResolvedDragEndpoints> {
  const timeoutMs = Math.max(0, Math.min(30_000, Number(command.timeout_ms ?? 30_000)));
  const startedAtMs = recordingClockMs();
  const remaining = () => Math.max(0, timeoutMs - (recordingClockMs() - startedAtMs));
  const source = await resolveDragEndpoint(
    options,
    command,
    "from",
    ordinal,
    recordingClockMs,
    remaining(),
  );
  const destination = await resolveDragEndpoint(
    options,
    command,
    "to",
    ordinal,
    recordingClockMs,
    remaining(),
  );
  return { source, destination };
}

async function probeRuntimeTarget(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  candidateSet: RuntimeTargetCandidateSet,
): Promise<RuntimeTargetResolution | null> {
  const attempts: RuntimeTargetResolution["attempts"] = [];
  for (const candidate of candidateSet.candidates) {
    const observation = await observeReadyCommandTarget(
      options,
      commandForRuntimeCandidate(command, candidate),
    );
    if (observation.status === "ready") {
      return {
        candidate,
        target: observation.target,
        diagnostics: observation.diagnostics,
        attempts,
        scrollTiming: null,
      };
    }
    attempts.push({
      key: candidate.key,
      source: candidate.source,
      fallbackIndex: candidate.fallbackIndex,
      reason: observation.reason,
    });
  }
  return null;
}

function legacyRuntimeTarget(
  candidateSet: RuntimeTargetCandidateSet,
  target: ActionTarget,
  scrollTiming: ActionScrollTiming | null,
): RuntimeTargetResolution | null {
  const candidate =
    candidateSet.candidates.find((item) => item.source === "story_target") ??
    candidateSet.candidates[0];
  return candidate ? { candidate, target, attempts: [], scrollTiming } : null;
}

async function resolveCommandVisibility(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  ordinal: number,
  recordingClockMs: () => number,
  timeoutMs = Math.min(Number(command.timeout_ms ?? 30_000), 30_000),
): Promise<ResolvedCommandVisibility> {
  const candidateSet = buildRuntimeTargetCandidates({ command, sidecar: options.targets });
  const mode = runtimeTargetCandidatesMode();
  if (candidateSet.diagnostics.length > 0) {
    if (options.recordingSessionId) {
      void recordEngineLog({
        level: "warn",
        event: "recording.target.candidate_validation_failed",
        context: {
          session_id: options.recordingSessionId,
          step_id: command.step_id ?? undefined,
          ordinal,
          phase: "target_candidate_validation",
          reason_code: "invalid_sidecar_candidate",
        },
        details: { diagnostic_count: candidateSet.diagnostics.length },
      });
    } else {
      void hostLog("warn", "runtime_target_sidecar_diagnostic", {
        ordinal,
        step_id: command.step_id ?? null,
        diagnostics: candidateSet.diagnostics,
      });
    }
  }

  if (!commandSupportsFallback(command) || !candidateSet.eligible || mode === "off") {
    const legacy = await recoverDetachedCommandTarget(
      options,
      { ...command, timeout_ms: timeoutMs },
      ordinal,
      recordingClockMs,
    );
    return {
      ...legacy,
      command,
      runtimeTarget: legacyRuntimeTarget(candidateSet, legacy.target, legacy.scrollTiming),
    };
  }

  if (mode === "shadow") {
    const legacy = await recoverDetachedCommandTarget(
      options,
      { ...command, timeout_ms: timeoutMs },
      ordinal,
      recordingClockMs,
    );
    const proposed = await probeRuntimeTarget(options, command, candidateSet);
    const actual = legacyRuntimeTarget(candidateSet, legacy.target, legacy.scrollTiming);
    const diverged = Boolean(proposed && proposed.candidate.key !== actual?.candidate.key);
    if (options.recordingSessionId) {
      void recordEngineLog({
        event: "recording.target.shadow_compared",
        context: {
          session_id: options.recordingSessionId,
          step_id: command.step_id ?? undefined,
          ordinal,
          phase: "target_resolution",
        },
        details: {
          candidate_count: candidateSet.candidates.length,
          actual_source: actual?.candidate.source ?? "story_target",
          proposed_source: proposed?.candidate.source ?? null,
          proposed_fallback_index: proposed?.candidate.fallbackIndex ?? null,
          attempt_count: proposed?.attempts.length ?? 0,
          diverged,
        },
      });
    } else {
      void hostLog("info", "runtime_target_shadow", {
        ordinal,
        step_id: command.step_id ?? null,
        candidate_count: candidateSet.candidates.length,
        actual_source: actual?.candidate.source ?? "story_target",
        proposed_source: proposed?.candidate.source ?? null,
        proposed_fallback_index: proposed?.candidate.fallbackIndex ?? null,
        diverged,
        attempted: proposed?.attempts ?? [],
      });
    }
    return { ...legacy, command, runtimeTarget: actual };
  }

  const resolved = await resolveRuntimeTarget(
    options,
    command,
    candidateSet,
    recordingClockMs,
    timeoutMs,
  );
  return {
    target: resolved.target,
    scrollTiming: resolved.scrollTiming,
    command: commandForRuntimeCandidate(command, resolved.candidate),
    runtimeTarget: resolved,
  };
}

function commandUsesBrowserCursorPath(command: ParsedCommand, includeCursor: boolean): boolean {
  return resolveCursorCommandPolicy(command.verb, includeCursor).emitVisibleTrajectory;
}

function cursorPathEventKey(
  command: ParsedCommand,
  ordinal: number,
  plan: CursorActionTimingPlan,
): string {
  return `${command.step_id ?? ""}:${ordinal}:${plan.preActionDelayMs}`;
}

async function performCursorPreActionPacing(input: {
  contents: WebContents;
  command: ParsedCommand;
  ordinal: number;
  plan: CursorActionTimingPlan;
  executionProfile: StoryBrowserExecutionProfile;
  pauseGate?: StoryBrowserRunOptions["pauseGate"];
  observeTarget?: () => ReturnType<typeof observeReadyCommandTarget>;
  targetShiftThresholdPx?: number;
  onCursorSample?: (point: { x: number; y: number }) => void;
}): Promise<{ lastPoint: { x: number; y: number }; shiftedTarget: ActionTarget | null }> {
  const {
    contents,
    command,
    ordinal,
    plan,
    executionProfile,
    pauseGate,
    observeTarget,
    targetShiftThresholdPx = 8,
    onCursorSample,
  } = input;
  const shouldInjectPath = commandUsesBrowserCursorPath(
    command,
    executionProfile.injectCursorPath !== false,
  );
  if (!shouldInjectPath) {
    return { lastPoint: plan.to, shiftedTarget: null };
  }

  const samples = sampleCursorMotionPath({
    from: plan.from,
    to: plan.to,
    travelMs: plan.requiredTravelMs,
    motionPreset: plan.motionPreset,
    eventKey: cursorPathEventKey(command, ordinal, plan),
  });
  let elapsedMs = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!sample) continue;
    const targetElapsedMs = Math.round(((index + 1) / samples.length) * plan.requiredTravelMs);
    const sampleDelayMs = Math.max(0, targetElapsedMs - elapsedMs);
    if (sampleDelayMs > 0) await waitForRecordingDelay(pauseGate, sampleDelayMs);
    elapsedMs += sampleDelayMs;
    contents.sendInputEvent({
      type: "mouseMove",
      x: Math.round(sample.x),
      y: Math.round(sample.y),
    });
    onCursorSample?.(sample);
    if (
      observeTarget &&
      (index === Math.floor(samples.length / 2) || index === samples.length - 1)
    ) {
      const observation = await observeTarget();
      if (
        observation.status === "ready" &&
        Math.hypot(
          plan.to.x - observation.target.center.x,
          plan.to.y - observation.target.center.y,
        ) > targetShiftThresholdPx
      ) {
        return { lastPoint: sample, shiftedTarget: observation.target };
      }
    }
  }
  if (plan.dwellMs > 0) await waitForRecordingDelay(pauseGate, plan.dwellMs);
  return { lastPoint: plan.to, shiftedTarget: null };
}

function cursorTargetShiftWarning(input: {
  command: ParsedCommand;
  ordinal: number;
  recordingSessionId?: string | null;
  before: ActionTarget;
  after: ActionTarget;
  thresholdPx: number;
}): void {
  const deltaPx = targetCenterDeltaPx(input.before, input.after);
  if (deltaPx <= input.thresholdPx) return;
  const details = {
    verb: input.command.verb,
    delta_px: Math.round(deltaPx * 100) / 100,
    threshold_px: input.thresholdPx,
  };
  if (input.recordingSessionId) {
    void recordEngineLog({
      level: "warn",
      event: "recording.cursor.target_shifted",
      context: {
        session_id: input.recordingSessionId,
        step_id: input.command.step_id ?? undefined,
        ordinal: input.ordinal,
        phase: "before_input",
        reason_code: "target_shifted",
      },
      details,
    });
  } else {
    void hostLog("warn", "cursor_target_shifted_before_input", {
      ordinal: input.ordinal,
      step_id: input.command.step_id ?? null,
      ...details,
    });
  }
}

function cursorPacingSizeForRun(
  contents: WebContents,
  fallback: CursorTimingSize | null | undefined,
): CursorTimingSize {
  if (fallback) return normalizeCursorTimingSize(fallback);
  try {
    const ownerWindow = (
      contents as WebContents & {
        getOwnerBrowserWindow?: () => {
          getContentBounds?: () => { width: number; height: number };
        } | null;
      }
    ).getOwnerBrowserWindow?.();
    const bounds = ownerWindow?.getContentBounds?.();
    return normalizeCursorTimingSize(
      bounds ? { width: bounds.width, height: bounds.height } : null,
    );
  } catch {
    return normalizeCursorTimingSize(null);
  }
}

export async function runStoryCommandsInBrowser(options: RecordingCheckpointRunOptions): Promise<{
  succeeded: number;
  failed: number;
  failedOrdinal: number | null;
  pausedOrdinal: number | null;
  exitReason: StoryBrowserRunExitReason;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const recordingClockMs = options.recordingClockMs ?? (() => Math.max(0, Date.now() - startedAt));
  const executionProfile = options.executionProfile ?? storyBrowserExecutionProfile();
  const loggingSessionId =
    options.recordingSessionId ??
    options.recordingCheckpointSessionId ??
    options.recordingRepairSessionId ??
    undefined;
  const repairController =
    options.recordingRepairSessionId && recordingRepairMode() === "manual_hybrid"
      ? recordingRepairController(options.recordingRepairSessionId)
      : null;
  const repairCandidateOverrides = new Map<string, RuntimeTargetCandidate>();
  let checkpointCoordinator = options.recordingCheckpointSessionId
    ? recordingCheckpointsForSession(options.recordingCheckpointSessionId)
    : null;
  const disableShadowCheckpoints = async (stage: string, error: unknown): Promise<void> => {
    const coordinator = checkpointCoordinator;
    checkpointCoordinator = null;
    const reason = error instanceof RecordingCheckpointError ? error.reason : "unexpected_error";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    if (loggingSessionId) {
      void recordEngineLog({
        level: "warn",
        event: "recording.checkpoint.failed",
        context: {
          session_id: loggingSessionId,
          phase: stage,
          reason_code: reason,
        },
        error,
      });
    }
    try {
      await coordinator?.recordShadowDivergence(stage, reason, errorName);
      if (coordinator?.activeSceneId) {
        await coordinator.closeScene("failed", options.captureStateSnapshot?.());
      }
    } catch {
      // Shadow artifacts are diagnostic; the monolithic recording remains authoritative.
    }
    if (options.recordingCheckpointSessionId) {
      try {
        await disposeRecordingCheckpoints(options.recordingCheckpointSessionId);
      } catch {
        // Final recording cleanup retries disposal.
      }
    }
  };
  const pacingSize = executionProfile.captureRecordingFrames
    ? cursorPacingSizeForRun(options.contents, executionProfile.captureSize)
    : null;
  let previousCursor = pacingSize ? initialCursorPoint(pacingSize) : null;
  const limit =
    options.stopAfter && options.stopAfter > 0
      ? Math.min(options.stopAfter, options.commands.length)
      : options.commands.length;
  let succeeded = 0;
  let failed = 0;
  let failedOrdinal: number | null = null;
  let lastOrdinal = 0;
  let exitReason: StoryBrowserRunExitReason = "completed";
  await ensureStoryInitialUrl(options.contents, options.storySource);

  for (let index = 0; index < limit; index += 1) {
    const ordinal = index + 1;
    if (options.pauseGate && !(await options.pauseGate.waitUntilRunning())) {
      exitReason = "cancelled";
      break;
    }
    if (options.shouldCancel?.()) {
      exitReason = "cancelled";
      break;
    }
    const sourceCommand = options.commands[index];
    const repairCandidate = sourceCommand.step_id
      ? repairCandidateOverrides.get(sourceCommand.step_id)
      : undefined;
    const command = repairCandidate
      ? commandForRuntimeCandidate(sourceCommand, repairCandidate)
      : sourceCommand;
    const commandPolicy = resolveCursorCommandPolicy(
      command.verb,
      executionProfile.injectCursorPath !== false,
    );
    if (loggingSessionId && commandPolicy.contributesActionEvent) {
      void recordEngineLog({
        event: "recording.cursor.policy_selected",
        context: {
          session_id: loggingSessionId,
          scene_id: command.scene_id ?? undefined,
          step_id: command.step_id ?? undefined,
          ordinal,
          phase: "pre_input",
        },
        details: {
          verb: command.verb,
          delivery: commandPolicy.delivery,
          presentation: commandPolicy.presentation,
          inject_cursor_path: executionProfile.injectCursorPath !== false,
        },
      });
    }
    lastOrdinal = ordinal;
    options.hooks?.onStepStarted?.(ordinal, command);
    const stepStartedAt = Date.now();
    const stepStartedClockMs = recordingClockMs();
    const landmarkEventId = `${ordinal}:${command.step_id ?? command.verb}`;
    let repairPhase: RecordingRepairPhase = "pre_input";
    let repairResult: RuntimeParsedCommandResult | null = null;
    let repairActionStartedClockMs = stepStartedClockMs;
    try {
      if (loggingSessionId && (command.verb === "drag" || command.verb === "upload")) {
        void recordEngineLog({
          event: command.verb === "drag" ? "recording.drag.started" : "recording.upload.started",
          context: {
            session_id: loggingSessionId,
            scene_id: command.scene_id ?? undefined,
            step_id: command.step_id ?? undefined,
            ordinal,
            phase: "pre_input",
          },
        });
      }
      if (command.verb === "drag" && dragExecutionMode() === "off") {
        throw new DragExecutionError("disabled", false);
      }
      if (command.verb === "upload" && uploadExecutionMode() === "off") {
        throw new FileUploadError("disabled");
      }
      const uploadAsset =
        command.verb === "upload"
          ? await resolveUploadAsset(options.projectFolder, command.path)
          : null;
      if (checkpointCoordinator) {
        try {
          const context = requiredSceneContext(command);
          if (!checkpointCoordinator.activeSceneId) {
            await checkpointCoordinator.beginScene(context);
          } else if (checkpointCoordinator.activeSceneId !== context.scene_id) {
            throw new RecordingCheckpointError("scene_boundary_unclosed");
          }
          const clock = options.recordingMediaClockSnapshot?.();
          if (!clock) throw new RecordingCheckpointError("media_clock_missing");
          checkpointCoordinator.beginStep(command, clock);
        } catch (error) {
          await disableShadowCheckpoints("begin_step", error);
        }
      }
      if (executionProfile.captureRecordingFrames) {
        invalidateAuthorPreviewPaintForContents(options.contents);
      }
      const isPacedCommand = commandPolicy.contributesActionEvent;
      let landmarkStarted = false;
      let preInputBarrierRequested = false;
      let dragEndpoints =
        command.verb === "drag"
          ? await resolveDragEndpoints(options, command, ordinal, recordingClockMs)
          : null;
      let visibility = commandUsesVisibilityPipeline(command)
        ? await resolveCommandVisibility(options, command, ordinal, recordingClockMs)
        : null;
      let executionCommand = dragEndpoints
        ? {
            ...command,
            target: dragEndpoints.source.candidate.target,
            target_nth: dragEndpoints.source.candidate.targetNth,
          }
        : (visibility?.command ?? command);
      let resolvedTarget = dragEndpoints
        ? dragEndpoints.source.target
        : visibility
          ? visibility.target
          : await resolveCommandTarget(options.contents, command);
      let secondaryTarget = dragEndpoints?.destination.target ?? null;
      let scrollTiming =
        visibility?.scrollTiming ??
        dragEndpoints?.source.scrollTiming ??
        dragEndpoints?.destination.scrollTiming ??
        null;
      let cursorPlan: CursorActionTimingPlan | null = null;
      let cursorStartedClockMs = recordingClockMs();
      if (pacingSize && previousCursor && resolvedTarget && isPacedCommand) {
        cursorStartedClockMs = recordingClockMs();
        options.actionLandmarks?.begin(landmarkEventId, {
          delivery: commandPolicy.delivery,
          point: previousCursor,
          expectsPresentation: commandPolicy.presentation === "required",
        });
        landmarkStarted = Boolean(options.actionLandmarks);
        let cursorFrom = previousCursor;
        const maxReplans = 3;
        for (let replan = 0; replan <= maxReplans; replan += 1) {
          cursorPlan = planCursorActionTiming({
            from: cursorFrom,
            target: resolvedTarget,
            size: pacingSize,
            motionPreset: executionProfile.cursorMotionPreset,
            minLeadMs: executionProfile.minCursorLeadMs,
          });
          const pacing = await performCursorPreActionPacing({
            contents: options.contents,
            command: executionCommand,
            ordinal,
            plan: cursorPlan,
            executionProfile:
              command.verb === "upload" && resolvedTarget.kind === "file_input_hidden"
                ? { ...executionProfile, injectCursorPath: false }
                : executionProfile,
            pauseGate: options.pauseGate,
            observeTarget: () => observeReadyCommandTarget(options, executionCommand),
            targetShiftThresholdPx: executionProfile.targetStabilityThresholdPx ?? 8,
            onCursorSample: (point) =>
              options.actionLandmarks?.updateCursor(landmarkEventId, point),
          });
          let targetAfterPacing: ActionTarget;
          try {
            targetAfterPacing =
              pacing.shiftedTarget ?? (await resolveReadyCommandTarget(options, executionCommand));
          } catch (error) {
            const elapsedStepMs = Math.max(0, recordingClockMs() - stepStartedClockMs);
            const remainingStepMs = Math.max(
              0,
              Math.min(Number(command.timeout_ms ?? 30_000), 30_000) - elapsedStepMs,
            );
            if (
              visibility?.runtimeTarget &&
              runtimeTargetCandidatesMode() === "enforce" &&
              runtimeTargetAttemptError(error) &&
              remainingStepMs > 0
            ) {
              visibility = await resolveCommandVisibility(
                options,
                command,
                ordinal,
                recordingClockMs,
                remainingStepMs,
              );
              executionCommand = visibility.command;
              resolvedTarget = visibility.target;
              scrollTiming = visibility.scrollTiming;
              cursorFrom = pacing.lastPoint;
              continue;
            }
            if (dragEndpoints && runtimeTargetAttemptError(error) && remainingStepMs > 0) {
              const source = await resolveDragEndpoint(
                options,
                command,
                "from",
                ordinal,
                recordingClockMs,
                remainingStepMs,
              );
              dragEndpoints = { ...dragEndpoints, source };
              executionCommand = {
                ...command,
                target: source.candidate.target,
                target_nth: source.candidate.targetNth,
              };
              resolvedTarget = source.target;
              cursorFrom = pacing.lastPoint;
              continue;
            }
            throw error;
          }
          cursorTargetShiftWarning({
            command: executionCommand,
            ordinal,
            recordingSessionId: options.recordingSessionId,
            before: resolvedTarget,
            after: targetAfterPacing,
            thresholdPx: executionProfile.targetStabilityThresholdPx ?? 8,
          });
          if (
            targetCenterDeltaPx(resolvedTarget, targetAfterPacing) <=
            (executionProfile.targetStabilityThresholdPx ?? 8)
          ) {
            resolvedTarget = targetAfterPacing;
            break;
          }
          if (replan === maxReplans) throw new InteractionReadinessError("unstable_geometry");
          cursorFrom = pacing.lastPoint;
          resolvedTarget = targetAfterPacing;
        }
        options.actionLandmarks?.updateCursor(
          landmarkEventId,
          cursorPointForTarget(resolvedTarget, pacingSize),
        );
        if (options.actionLandmarks) {
          const arrival = options.actionLandmarks.waitForArrivalOutcome(
            landmarkEventId,
            options.frameSyncTimeoutMs ?? FRAME_SYNC_FALLBACK_TIMEOUT_MS,
          );
          const requestedOutcome = await requestFrameCommitOutcome(options.requestFrameCommit);
          preInputBarrierRequested = Boolean(options.requestFrameCommit);
          if (requestedOutcome?.status === "committed") {
            options.actionLandmarks.anchorArrival(landmarkEventId, requestedOutcome.landmark);
          }
          if (requestedOutcome?.status === "degraded") {
            options.actionLandmarks.degradeArrival(
              landmarkEventId,
              requestedOutcome.reason as FrameSyncDegradedReason,
            );
          } else if (requestedOutcome?.status === "cancelled") {
            options.actionLandmarks.cancelArrival(landmarkEventId);
          }
          const arrivalOutcome = await arrival;
          if (arrivalOutcome.status === "cancelled") throw new RecordingPauseCancelledError();
          if (arrivalOutcome.status === "degraded") {
            logFrameSyncDegradation({
              options,
              recordingSessionId: loggingSessionId,
              command,
              ordinal,
              barrier: "cursor_arrival",
              reason: arrivalOutcome.reason,
            });
            options.actionLandmarks.discard(landmarkEventId);
            landmarkStarted = false;
            if (command.verb === "drag") {
              throw new DragExecutionError("frame_barrier_failed", false);
            }
          }
        }
      }
      if (commandMutatesCapturedPage(command) && !preInputBarrierRequested) {
        const requestedOutcome = await requestFrameCommitOutcome(options.requestFrameCommit);
        if (requestedOutcome?.status === "cancelled") throw new RecordingPauseCancelledError();
        if (requestedOutcome?.status === "degraded") {
          logFrameSyncDegradation({
            options,
            recordingSessionId: loggingSessionId,
            command,
            ordinal,
            barrier: "pre_input",
            reason: requestedOutcome.reason,
          });
        }
      }
      let destinationCommand: ParsedCommand | null = null;
      if (dragEndpoints) {
        destinationCommand = dragEndpointCommand(
          command,
          "to",
          dragEndpoints.destination.candidate,
        );
        const destinationObservation = await observeReadyCommandTarget(options, destinationCommand);
        if (destinationObservation.status !== "ready") {
          throw new RuntimeTargetAttemptError(
            destinationObservation.reason,
            "diagnostics" in destinationObservation
              ? destinationObservation.diagnostics
              : undefined,
          );
        }
        secondaryTarget = destinationObservation.target;
        dragEndpoints = {
          ...dragEndpoints,
          destination: { ...dragEndpoints.destination, target: destinationObservation.target },
        };
      }
      await waitForRecordingDelay(options.pauseGate, 0);
      const actionStartedAt = Date.now();
      const actionStartedClockMs = recordingClockMs();
      repairActionStartedClockMs = actionStartedClockMs;
      const parsedResult = await executeParsedCommand(
        options.contents,
        executionCommand,
        options.projectFolder,
        {
          executionProfile,
          resolvedTarget,
          resolvedSecondaryTarget: secondaryTarget,
          resolvedUploadAsset: uploadAsset,
          pauseGate: options.pauseGate,
          shouldCancel: options.shouldCancel,
          validateSecondaryTarget: destinationCommand
            ? async () =>
                (await observeReadyCommandTarget(options, destinationCommand)).status === "ready"
            : undefined,
          beforeInputSideEffect: landmarkStarted
            ? () => options.actionLandmarks?.armPresentation(landmarkEventId)
            : undefined,
          onInputSideEffect: landmarkStarted
            ? (kind) => {
                repairPhase =
                  commandPolicy.presentation === "required"
                    ? "input_emitted_presentation_pending"
                    : "post_input_failed";
                options.actionLandmarks?.markInput(landmarkEventId, kind);
              }
            : undefined,
        },
      );
      const result: RuntimeParsedCommandResult = dragEndpoints
        ? { ...parsedResult, runtimeTargets: dragEndpoints }
        : visibility?.runtimeTarget
          ? { ...parsedResult, runtimeTarget: visibility.runtimeTarget }
          : parsedResult;
      if (loggingSessionId && (result.runtimeTarget || result.runtimeTargets)) {
        const runtimeTarget = result.runtimeTarget;
        void recordEngineLog({
          event: "recording.target.resolved",
          context: {
            session_id: loggingSessionId,
            scene_id: command.scene_id ?? undefined,
            step_id: command.step_id ?? undefined,
            ordinal,
            phase: "pre_input",
          },
          details: runtimeTarget
            ? {
                source: runtimeTarget.candidate.source,
                fallback_index: runtimeTarget.candidate.fallbackIndex,
                target_strategy: runtimeTarget.candidate.summary.kind,
                target_hash: runtimeTarget.candidate.key.replace(/^target:/, ""),
                attempt_count: runtimeTarget.attempts.length,
              }
            : {
                source: result.runtimeTargets?.source.candidate.source ?? null,
                source_fallback_index:
                  result.runtimeTargets?.source.candidate.fallbackIndex ?? null,
                source_strategy: result.runtimeTargets?.source.candidate.summary.kind ?? null,
                source_target_hash:
                  result.runtimeTargets?.source.candidate.key.replace(/^target:/, "") ?? null,
                destination: result.runtimeTargets?.destination.candidate.source ?? null,
                destination_fallback_index:
                  result.runtimeTargets?.destination.candidate.fallbackIndex ?? null,
                destination_strategy:
                  result.runtimeTargets?.destination.candidate.summary.kind ?? null,
                destination_target_hash:
                  result.runtimeTargets?.destination.candidate.key.replace(/^target:/, "") ?? null,
              },
        });
      }
      if (loggingSessionId && command.verb === "drag") {
        void recordEngineLog({
          event: "recording.drag.completed",
          context: {
            session_id: loggingSessionId,
            scene_id: command.scene_id ?? undefined,
            step_id: command.step_id ?? undefined,
            ordinal,
            phase: "post_input",
            duration_ms: Math.max(0, recordingClockMs() - repairActionStartedClockMs),
          },
          details: { sample_count: parsedResult.dragSamples?.length ?? 0 },
        });
      } else if (loggingSessionId && command.verb === "upload") {
        void recordEngineLog({
          event: "recording.upload.completed",
          context: {
            session_id: loggingSessionId,
            scene_id: command.scene_id ?? undefined,
            step_id: command.step_id ?? undefined,
            ordinal,
            phase: "post_input",
            duration_ms: Math.max(0, recordingClockMs() - repairActionStartedClockMs),
          },
          details: {
            file_count: uploadAsset ? 1 : 0,
            file_type: uploadAsset
              ? path.extname(uploadAsset.basename).slice(1).toLowerCase() || "unknown"
              : "unknown",
            total_bytes: uploadAsset?.byteSize ?? 0,
          },
        });
      }
      repairResult = result;
      if (landmarkStarted && commandPolicy.presentation === "required") {
        const presentation = await options.actionLandmarks?.waitForPresentation(
          landmarkEventId,
          500,
        );
        if (presentation?.status === "timeout") {
          const error = new Error("action presentation timed out");
          Object.assign(error, { recordingReasonCode: "presentation_timeout" });
          throw error;
        }
        repairPhase = "post_input_failed";
      }
      const actionDurationMs = isPacedCommand
        ? actionStartedAt - stepStartedAt
        : Date.now() - stepStartedAt;
      const settleDelayMs = executionProfile.settleDelayForCommand(command);
      if (settleDelayMs > 0) await waitForRecordingDelay(options.pauseGate, settleDelayMs);
      const stepEndedClockMs = recordingClockMs();
      const durationMs = Math.max(0, stepEndedClockMs - stepStartedClockMs);
      const explicitTiming =
        cursorPlan &&
        commandPolicy.applyCursorPacing &&
        resolvedTarget?.kind !== "file_input_hidden"
          ? cursorTimelineTimingFromPlan({
              plan: cursorPlan,
              verb: command.verb,
              stepStartedAtMs: cursorStartedClockMs,
              actionAtMs: actionStartedClockMs,
            })
          : null;
      const landmarks = landmarkStarted
        ? (options.actionLandmarks?.finish(landmarkEventId) ?? null)
        : null;
      if (
        pacingSize &&
        result.target &&
        result.target.kind !== "file_input_hidden" &&
        commandPolicy.contributesActionEvent
      ) {
        previousCursor = cursorPointForTarget(result.target, pacingSize);
      }
      if (checkpointCoordinator) {
        try {
          const checkpointFrame = await requestFrameCommitOutcome(options.requestFrameCommit);
          if (checkpointFrame?.status !== "committed") {
            throw new RecordingCheckpointError("step_media_uncommitted");
          }
          await checkpointCoordinator.commitStep({
            command,
            actionEventId: commandPolicy.contributesActionEvent
              ? `${command.step_id ?? "step"}:${ordinal}`
              : null,
            url: options.contents.getURL(),
            targetKind: result.target?.kind ?? null,
            health: options.captureStateSnapshot?.(),
          });
          const nextCommand = options.commands[index + 1];
          if (!nextCommand || nextCommand.scene_id !== command.scene_id) {
            await options.captureSceneTail?.();
            await checkpointCoordinator.closeScene("committed", options.captureStateSnapshot?.());
          }
        } catch (error) {
          await disableShadowCheckpoints("commit_step", error);
        }
      }
      succeeded += 1;
      options.hooks?.onStepSucceeded?.({
        ordinal,
        command,
        result,
        durationMs,
        actionDurationMs,
        timing: {
          stepStartedAtMs: stepStartedClockMs,
          actionAtMs: actionStartedClockMs,
          stepEndedAtMs: stepEndedClockMs,
          scrollTiming,
          cursorTiming: explicitTiming?.cursorTiming ?? null,
          inputTiming: explicitTiming?.inputTiming ?? null,
          landmarks,
        },
      });
      if (options.frameDir) {
        const screenshotPath = await captureStoryFrame(
          options.contents,
          options.frameDir,
          ordinal,
          result.screenshotPath,
        );
        const frame = simulatorFrameFromResult(
          ordinal,
          command,
          options.targets,
          result,
          screenshotPath,
          durationMs,
        );
        options.hooks?.onFrameCaptured?.(ordinal, frame);
      }
    } catch (error) {
      if (error instanceof RecordingPauseCancelledError) {
        exitReason = "cancelled";
        break;
      }
      if (loggingSessionId) {
        const reasonCode =
          typeof (error as { recordingReasonCode?: unknown })?.recordingReasonCode === "string"
            ? String((error as { recordingReasonCode: string }).recordingReasonCode)
            : error instanceof RuntimeTargetCandidatesExhaustedError
              ? error.reason
              : "step_failed";
        void recordEngineLog({
          level: "warn",
          event:
            command.verb === "drag"
              ? "recording.drag.failed"
              : command.verb === "upload"
                ? "recording.upload.failed"
                : "recording.target.failed",
          context: {
            session_id: loggingSessionId,
            scene_id: command.scene_id ?? undefined,
            step_id: command.step_id ?? undefined,
            ordinal,
            phase: repairPhase,
            reason_code: reasonCode,
            duration_ms: Math.max(0, recordingClockMs() - stepStartedClockMs),
          },
          details: {
            verb: command.verb,
            ...(error instanceof RuntimeTargetCandidatesExhaustedError
              ? {
                  attempt_count: error.attempts.length,
                  attempts: error.attempts.map((attempt) => ({
                    source: attempt.source,
                    fallback_index: attempt.fallbackIndex,
                    reason: attempt.reason,
                  })),
                }
              : {}),
          },
          error,
        });
      }
      const screenshotPath = await captureFailureFrameBestEffort(
        options.contents,
        options.failureFrameDir,
        ordinal,
      );
      if (repairController && command.scene_id && command.step_id) {
        const candidateSet = buildRuntimeTargetCandidates({
          command: sourceCommand,
          sidecar: options.targets as RuntimeTargetSidecar,
        });
        const wasRunning = options.pauseGate?.state === "running";
        let recordingPausedForRepair = false;
        if (options.pauseRecordingForRepair) {
          await options.pauseRecordingForRepair();
          recordingPausedForRepair = true;
        }
        if (wasRunning) options.pauseGate?.pause();
        if (checkpointCoordinator?.activeSceneId) {
          try {
            await checkpointCoordinator.closeScene("failed", options.captureStateSnapshot?.());
          } catch (checkpointError) {
            await disableShadowCheckpoints("repair_failure", checkpointError);
          }
        }
        const pending = repairController.begin({
          session_id: options.recordingRepairSessionId as string,
          scene_id: command.scene_id,
          step_id: command.step_id,
          ordinal,
          phase: repairPhase,
          reason_code:
            typeof (error as { recordingReasonCode?: unknown })?.recordingReasonCode === "string"
              ? String((error as { recordingReasonCode: string }).recordingReasonCode)
              : "step_failed",
          candidates: candidateSet.candidates.map((candidate) => ({
            key: candidate.key,
            source: candidate.source,
            fallback_index: candidate.fallbackIndex,
          })),
          scene_retry_available: Boolean(
            checkpointCoordinator &&
              options.restoreSceneEntry &&
              (options.canRestoreSceneEntry?.(command.scene_id) ?? true),
          ),
        });
        options.onRepairRequired?.(pending.event);
        const resolution = await pending.resolution;
        const shouldResume = resolution.action !== "abort_keep_salvage";
        if (shouldResume && recordingPausedForRepair) {
          await options.resumeRecordingForRepair?.();
        }
        if (wasRunning && options.pauseGate?.state === "paused") {
          options.pauseGate.resume();
        }
        if (resolution.action === "retry_step" || resolution.action === "use_candidate_and_retry") {
          if (resolution.action === "use_candidate_and_retry" && resolution.candidate_key) {
            const candidate = candidateSet.candidates.find(
              (item) => item.key === resolution.candidate_key,
            );
            if (candidate && command.step_id)
              repairCandidateOverrides.set(command.step_id, candidate);
          }
          index -= 1;
          continue;
        }
        if (resolution.action === "await_presentation" && repairResult) {
          options.actionLandmarks?.armPresentation(landmarkEventId);
          const presentation = await options.actionLandmarks?.waitForPresentation(
            landmarkEventId,
            500,
          );
          const frame =
            presentation?.status === "presented"
              ? await requestFrameCommitOutcome(options.requestFrameCommit)
              : null;
          if (presentation?.status === "presented" && frame?.status === "committed") {
            const stepEndedClockMs = recordingClockMs();
            const landmarks = options.actionLandmarks?.finish(landmarkEventId) ?? null;
            succeeded += 1;
            options.hooks?.onStepSucceeded?.({
              ordinal,
              command,
              result: repairResult,
              durationMs: Math.max(0, stepEndedClockMs - stepStartedClockMs),
              actionDurationMs: Math.max(0, repairActionStartedClockMs - stepStartedClockMs),
              timing: {
                stepStartedAtMs: stepStartedClockMs,
                actionAtMs: repairActionStartedClockMs,
                stepEndedAtMs: stepEndedClockMs,
                scrollTiming: null,
                cursorTiming: null,
                inputTiming: null,
                landmarks,
              },
            });
            continue;
          }
        }
        if (resolution.action === "retry_scene" && options.restoreSceneEntry) {
          const restored = await options.restoreSceneEntry(command.scene_id);
          if (restored) {
            const sceneStart = options.commands.findIndex(
              (candidate) => candidate.scene_id === command.scene_id,
            );
            if (sceneStart >= 0) {
              succeeded = Math.max(0, succeeded - Math.max(0, index - sceneStart));
              for (const candidate of options.commands.slice(sceneStart, index + 1)) {
                if (candidate.step_id) repairCandidateOverrides.delete(candidate.step_id);
              }
              index = sceneStart - 1;
              continue;
            }
          }
        }
      }
      failed += 1;
      failedOrdinal = ordinal;
      exitReason = "failed";
      options.hooks?.onStepFailed?.(ordinal, error, screenshotPath);
      break;
    }
  }
  if (exitReason === "completed" && limit < options.commands.length) {
    exitReason = "paused";
  }
  if (checkpointCoordinator?.activeSceneId) {
    try {
      await checkpointCoordinator.closeScene(
        exitReason === "cancelled" ? "cancelled" : "failed",
        options.captureStateSnapshot?.(),
      );
    } catch (error) {
      await disableShadowCheckpoints("close_run", error);
    }
  }

  return {
    succeeded,
    failed,
    failedOrdinal,
    pausedOrdinal: exitReason === "paused" ? lastOrdinal || limit : null,
    exitReason,
    durationMs: Date.now() - startedAt,
  };
}

function logSidecarWriteFailure(
  sessionId: string,
  sidecarKind: "actions" | "steps",
  error: unknown,
): void {
  void recordEngineLog({
    level: "warn",
    event: "recording.sidecar.write_failed",
    context: {
      session_id: sessionId,
      phase: sidecarKind,
      reason_code: "sidecar_write_failed",
    },
    details: { sidecar_kind: sidecarKind },
    error,
  });
}

export async function writeRecordingActionsSidecarBestEffort(
  session: RecordingSession,
  events: ActionTimelineEvent[],
  options: {
    cursorMotionPreset?: ActionCursorTiming["motion_preset"];
    strict?: boolean;
  } = {},
): Promise<void> {
  const file = actionsSidecarPath(session.outputPath);
  const syncMode = resolveCursorSyncMode();
  const strictOutcome = recordingOutcomeMode() === "strict";
  const version = strictOutcome || syncMode === "unified" ? 3 : 2;
  if (events.length === 0 && version !== 3) return;
  try {
    const authoritativeEvents = events.filter((event) => event.input_landmarks?.action).length;
    const invalidOrderingEvents = events.filter((event) => {
      const arrival = event.cursor_path?.arrival.pts_us;
      const action = event.input_landmarks?.action?.pts_us;
      const frame = event.presentation?.first_post_input_frame?.pts_us;
      return (
        arrival != null && action != null && (arrival > action || (frame != null && action > frame))
      );
    }).length;
    if (syncMode === "shadow") {
      void recordEngineLog({
        event: "recording.cursor.shadow_compared",
        context: { session_id: session.id, phase: "sidecar_validation" },
        details: {
          event_count: events.length,
          authoritative_event_count: authoritativeEvents,
          invalid_ordering_event_count: invalidOrderingEvents,
          diverged: invalidOrderingEvents > 0,
          sync_mode: syncMode,
        },
      });
    }
    const actions = recordingActionsFromSession(session, events, {
      cursorMotionPreset: options.cursorMotionPreset,
      version,
    });
    if (version === 3) {
      validateRecordingActionsV3(actions, { requirePresented: strictOutcome });
    }
    await writeActionsSidecarAtomic(file, actions);
  } catch (error) {
    logSidecarWriteFailure(session.id, "actions", error);
    if (options.strict || strictOutcome || syncMode === "unified") throw error;
  }
}

interface RecordingStepTiming {
  ordinal: number;
  stepId: string | null;
  sceneName: string;
  verb: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "succeeded" | "failed";
  cursor: { x: number; y: number } | null;
  target: {
    selector: string | null;
    bbox: { x: number; y: number; w: number; h: number };
    matchKind: "primary";
    source: RuntimeTargetCandidate["source"] | null;
    fallbackIndex: number | null;
    key: string | null;
  } | null;
  confidence: "high" | "low";
}

async function writeRecordingStepTimingSidecarBestEffort(
  session: RecordingSession,
  source: string,
  steps: RecordingStepTiming[],
  status: "completed" | "failed" | "partial",
): Promise<void> {
  const file = sidecarPath(session.outputPath, "steps");
  try {
    await writeJsonAtomic(file, {
      version: 1,
      recordingPath: session.outputPath,
      captureRect: deriveActionCaptureRect(session),
      storyHash: storyHash(source),
      timebase: "recording-ms",
      status,
      steps,
    });
  } catch (error) {
    logSidecarWriteFailure(session.id, "steps", error);
  }
}

export function rebaseActionEventsToFirstCursorInteraction(
  events: ActionTimelineEvent[],
): ActionTimelineEvent[] {
  const first = events[0];
  if (!first) return events;
  const offsetMs = Math.max(0, Math.min(first.t_start_ms, first.t_action_ms));
  if (offsetMs <= 0) return events;
  return events.map((event) => ({
    ...event,
    t_start_ms: Math.max(0, event.t_start_ms - offsetMs),
    t_action_ms: Math.max(0, event.t_action_ms - offsetMs),
    t_end_ms: Math.max(0, event.t_end_ms - offsetMs),
    ...(event.cursor_timing
      ? { cursor_timing: rebaseCursorTiming(event.cursor_timing, offsetMs) }
      : {}),
    ...(event.input_timing
      ? { input_timing: rebaseInputTiming(event.input_timing, offsetMs) }
      : {}),
  }));
}

function rebaseCursorTiming(timing: ActionCursorTiming, offsetMs: number): ActionCursorTiming {
  const startMs = Math.max(0, timing.start_ms - offsetMs);
  const arrivalMs = Math.max(0, timing.arrival_ms - offsetMs);
  return {
    ...timing,
    start_ms: startMs,
    arrival_ms: arrivalMs,
    travel_ms: Math.max(0, arrivalMs - startMs),
  };
}

function rebaseInputTiming(timing: ActionInputTiming, offsetMs: number): ActionInputTiming {
  return {
    ...timing,
    action_ms: Math.max(0, timing.action_ms - offsetMs),
    ...(timing.down_ms != null ? { down_ms: Math.max(0, timing.down_ms - offsetMs) } : {}),
    ...(timing.up_ms != null ? { up_ms: Math.max(0, timing.up_ms - offsetMs) } : {}),
    ...(timing.text_start_ms != null
      ? { text_start_ms: Math.max(0, timing.text_start_ms - offsetMs) }
      : {}),
    ...(timing.text_end_ms != null
      ? { text_end_ms: Math.max(0, timing.text_end_ms - offsetMs) }
      : {}),
  };
}

export async function launchAutomationCommand(args: Record<string, unknown>, sender: WebContents) {
  const onEvent = channelIdFrom(args.onEvent);
  const source = String(args.storySource ?? "");
  const storyPath = typeof args.storyPath === "string" ? args.storyPath : "";
  const projectFolder = String(args.projectFolder ?? app.getPath("userData"));
  const parsedStory = parseStorySource(source).ast;
  const commands = (parsedStory?.scenes.flatMap((scene) => scene.commands) ??
    []) as ParsedCommand[];
  const sceneNames =
    parsedStory?.scenes.flatMap((scene) => scene.commands.map(() => scene.name)) ?? [];
  const streamId = typeof args.streamId === "string" ? args.streamId : null;
  const recordingSessionId =
    typeof args.recordingSessionId === "string" ? args.recordingSessionId : null;
  sendChannel(sender, onEvent, {
    json: JSON.stringify({
      type: "story_started",
      story_hash: storyHash(source),
    }),
  });
  sendChannel(sender, onEvent, {
    json: JSON.stringify({
      type: "scene_entered",
      name: "Electron preview",
      ordinal: 1,
    }),
  });
  const ownedWindow =
    streamId == null
      ? new BrowserWindow({
          show: false,
          width: 1280,
          height: 800,
          webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false,
          },
        })
      : null;
  const contents = streamId ? authorSession(streamId).window.webContents : ownedWindow?.webContents;
  if (!contents) throw new Error("browser session unavailable for automation");
  const targets = storyPath ? await readTargetsForStory(storyPath) : { version: 1, steps: {} };
  const recordingSessionAtLaunch = recordingSessionId
    ? recordingSessions.get(recordingSessionId)
    : null;
  const actionEvents: ActionTimelineEvent[] = [];
  const stepTimings: RecordingStepTiming[] = [];
  const actionStepStartMs = new Map<number, number>();
  const actionRunStartedAt = recordingSessionAtLaunch?.startedAt ?? Date.now();
  const executionProfile = {
    ...storyBrowserExecutionProfile({
      captureRecordingFrames: Boolean(recordingSessionId),
      includeCursor:
        (recordingSessionAtLaunch as (RecordingSession & { includeCursor?: boolean }) | null)
          ?.includeCursor ?? true,
      captureSize: recordingSessionAtLaunch
        ? {
            width: recordingSessionAtLaunch.width,
            height: recordingSessionAtLaunch.height,
          }
        : undefined,
    }),
    recordingFps: recordingSessionAtLaunch?.fps ?? 30,
  };
  const failureFrameDir = userDataPath("automation-runs", randomUUID(), "diagnostics");
  const sceneEntryUrl = (sceneId: string) => liveSceneEntryUrlForRepair(commands, sceneId, source);
  let result: Awaited<ReturnType<typeof runStoryCommandsInBrowser>>;
  try {
    result = await runStoryCommandsInBrowser({
      contents,
      commands,
      projectFolder,
      storySource: source,
      targets,
      executionProfile,
      failureFrameDir,
      recordingSessionId: recordingSessionAtLaunch?.id ?? null,
      recordingClockMs: recordingSessionAtLaunch
        ? () => recordingFrameClockMs(recordingSessionAtLaunch)
        : undefined,
      recordingCheckpointSessionId: recordingSessionAtLaunch?.id ?? null,
      recordingMediaClockSnapshot: recordingSessionAtLaunch
        ? () => recordingSessionAtLaunch.mediaClock.snapshot()
        : undefined,
      captureSceneTail: recordingSessionAtLaunch
        ? () => captureAutomationRecordingTail(recordingSessionAtLaunch)
        : undefined,
      recordingRepairSessionId: recordingSessionAtLaunch?.id ?? null,
      onRepairRequired: (event) => {
        sendChannel(sender, onEvent, { json: JSON.stringify(event) });
      },
      pauseRecordingForRepair: recordingSessionAtLaunch
        ? async () => {
            await pauseRecording({ id: recordingSessionAtLaunch.id });
          }
        : undefined,
      resumeRecordingForRepair: recordingSessionAtLaunch
        ? async () => {
            await resumeRecording({ id: recordingSessionAtLaunch.id });
          }
        : undefined,
      canRestoreSceneEntry: recordingSessionAtLaunch
        ? (sceneId) => sceneEntryUrl(sceneId) !== null
        : undefined,
      restoreSceneEntry: recordingSessionAtLaunch
        ? async (sceneId) => {
            const url = sceneEntryUrl(sceneId);
            if (!url || contents.isDestroyed()) return false;
            try {
              await contents.loadURL(url);
              invalidateAuthorPreviewPaintForContents(contents);
              return true;
            } catch {
              return false;
            }
          }
        : undefined,
      actionLandmarks: recordingSessionAtLaunch?.actionLandmarks,
      requestFrameCommit: recordingSessionAtLaunch
        ? () => requestRecordingFrameCommit(recordingSessionAtLaunch)
        : undefined,
      frameSyncTimeoutMs: recordingSessionAtLaunch
        ? recordingFrameCommitBudgetMs(recordingSessionAtLaunch)
        : undefined,
      captureStateSnapshot: recordingSessionAtLaunch
        ? () => recordingCaptureStateSnapshot(recordingSessionAtLaunch)
        : undefined,
      pauseGate: recordingSessionAtLaunch?.pauseGate,
      shouldCancel: recordingSessionAtLaunch
        ? () =>
            recordingSessions.get(recordingSessionAtLaunch.id) !== recordingSessionAtLaunch ||
            recordingLifecycle.isCancellationRequested(recordingSessionAtLaunch.id)
        : undefined,
      hooks: {
        onStepStarted: (ordinal, command) => {
          if (recordingSessionAtLaunch) {
            actionStepStartMs.set(ordinal, recordingFrameClockMs(recordingSessionAtLaunch));
          }
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_started",
              ordinal,
              command,
              driver_used: "electron",
            }),
          });
        },
        onStepSucceeded: ({
          ordinal,
          command,
          result: stepResult,
          durationMs,
          actionDurationMs,
          timing,
        }) => {
          const runtimeResult = stepResult as RuntimeParsedCommandResult;
          const runtimeTargets = runtimeResult.runtimeTargets ?? null;
          const runtimeTarget = runtimeResult.runtimeTarget ?? runtimeTargets?.destination ?? null;
          const matchedCommand = runtimeTarget
            ? commandForRuntimeCandidate(command, runtimeTarget.candidate)
            : command;
          const fallbackStepEndedAtMs = recordingSessionAtLaunch
            ? recordingFrameClockMs(recordingSessionAtLaunch)
            : Math.max(0, Date.now() - actionRunStartedAt);
          const stepEndedAtMs = timing?.stepEndedAtMs ?? fallbackStepEndedAtMs;
          const stepStartedAtMs =
            timing?.stepStartedAtMs ??
            actionStepStartMs.get(ordinal) ??
            Math.max(0, stepEndedAtMs - durationMs);
          actionStepStartMs.delete(ordinal);
          const actionAtMs = Math.min(
            stepEndedAtMs,
            timing?.actionAtMs ?? stepStartedAtMs + Math.max(0, actionDurationMs),
          );
          if (recordingSessionAtLaunch) {
            stepTimings.push({
              ordinal,
              stepId: command.step_id ?? null,
              sceneName: sceneNames[ordinal - 1] ?? "Unknown scene",
              verb: command.verb,
              startMs: stepStartedAtMs,
              endMs: stepEndedAtMs,
              durationMs: Math.max(0, stepEndedAtMs - stepStartedAtMs),
              status: "succeeded",
              cursor: stepResult.cursor ?? null,
              target: stepResult.target
                ? {
                    selector: targetSelector(matchedCommand.target),
                    bbox: stepResult.target.bounds,
                    matchKind: "primary",
                    source: runtimeTarget?.candidate.source ?? null,
                    fallbackIndex: runtimeTarget?.candidate.fallbackIndex ?? null,
                    key: runtimeTarget?.candidate.key ?? null,
                  }
                : null,
              confidence: "high",
            });
          }
          if (recordingSessionId && commandContributesCursorEvent(command)) {
            const actionEvent = actionTimelineEventFromStep({
              ordinal,
              command: matchedCommand,
              stepStartedAtMs,
              actionAtMs,
              stepEndedAtMs,
              target: stepResult.target,
              secondaryTarget: runtimeResult.source ?? null,
              pointer: stepResult.pointer ?? undefined,
              scrollTiming: timing?.scrollTiming ?? null,
              cursorTiming: timing?.cursorTiming ?? null,
              inputTiming: timing?.inputTiming ?? null,
              landmarks: timing?.landmarks ?? null,
              includeCursor: executionProfile.injectCursorPath !== false,
              cursorApplicable: stepResult.target?.kind !== "file_input_hidden",
              targetMatch: runtimeTarget
                ? {
                    source: runtimeTarget.candidate.source,
                    fallbackIndex: runtimeTarget.candidate.fallbackIndex,
                  }
                : null,
              gesture:
                command.verb === "drag" && runtimeResult.source && stepResult.target
                  ? {
                      kind: "drag",
                      source: runtimeResult.source.center,
                      destination: stepResult.target.center,
                      samples: runtimeResult.dragSamples?.map((sample) => ({
                        x: sample.x,
                        y: sample.y,
                        elapsed_ms: sample.elapsedMs,
                      })),
                      source_match: runtimeTargets
                        ? {
                            source: runtimeTargets.source.candidate.source,
                            fallback_index: runtimeTargets.source.candidate.fallbackIndex,
                          }
                        : undefined,
                      destination_match: runtimeTargets
                        ? {
                            source: runtimeTargets.destination.candidate.source,
                            fallback_index: runtimeTargets.destination.candidate.fallbackIndex,
                          }
                        : undefined,
                    }
                  : null,
              uploadAsset: runtimeResult.uploadAsset ?? null,
            });
            actionEvents.push(actionEvent);
            try {
              recordingCheckpointsForSession(recordingSessionId)?.recordAction(
                `${command.step_id ?? "step"}:${ordinal}`,
                actionEvent,
              );
            } catch (error) {
              void recordEngineLog({
                level: "warn",
                event: "recording.checkpoint.failed",
                context: {
                  session_id: recordingSessionId,
                  step_id: command.step_id ?? undefined,
                  ordinal,
                  phase: "action_capture",
                  reason_code: "checkpoint_action_capture_failed",
                },
                error,
              });
            }
          }
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_succeeded",
              ordinal,
              step_id: command.step_id ?? null,
              duration_ms: durationMs,
              cursor_x: stepResult.cursor?.x ?? 0,
              cursor_y: stepResult.cursor?.y ?? 0,
              matched_selector: targetSelector(matchedCommand.target),
              matched_bbox: stepResult.target?.bounds ?? null,
              match_kind: stepResult.cursor ? "primary" : "none",
              target_source: runtimeTarget?.candidate.source ?? null,
              fallback_index: runtimeTarget?.candidate.fallbackIndex ?? null,
              target_key: runtimeTarget?.candidate.key ?? null,
              target_attempts: runtimeTarget?.attempts ?? [],
              source_target_attempts: runtimeTargets?.source.attempts ?? [],
            }),
          });
          if (stepResult.screenshotPath) {
            const frame = simulatorFrameFromResult(
              ordinal,
              command,
              targets,
              stepResult,
              stepResult.screenshotPath,
              durationMs,
            );
            sendChannel(sender, onEvent, {
              json: JSON.stringify({
                type: "step_frame_captured",
                ordinal,
                frame,
              }),
            });
          }
        },
        onStepFailed: (ordinal, error, screenshotPath) => {
          const stepStartedAtMs = actionStepStartMs.get(ordinal);
          actionStepStartMs.delete(ordinal);
          if (recordingSessionAtLaunch && stepStartedAtMs != null) {
            const command = commands[ordinal - 1];
            const stepEndedAtMs = recordingFrameClockMs(recordingSessionAtLaunch);
            if (command) {
              stepTimings.push({
                ordinal,
                stepId: command.step_id ?? null,
                sceneName: sceneNames[ordinal - 1] ?? "Unknown scene",
                verb: command.verb,
                startMs: stepStartedAtMs,
                endMs: stepEndedAtMs,
                durationMs: Math.max(0, stepEndedAtMs - stepStartedAtMs),
                status: "failed",
                cursor: null,
                target: null,
                confidence: "low",
              });
            }
          }
          const diagnostics = automationFailureDiagnostics(error);
          const attempts =
            error instanceof RuntimeTargetCandidatesExhaustedError
              ? error.attempts
              : diagnostics
                ? [diagnostics]
                : [];
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_failed",
              ordinal,
              attempts,
              error_message: error instanceof Error ? error.message : String(error),
              screenshot_path: screenshotPath ?? undefined,
            }),
          });
        },
      },
    });
  } finally {
    if (ownedWindow && !ownedWindow.isDestroyed()) ownedWindow.destroy();
  }
  const recordingSession = recordingSessionId ? recordingSessions.get(recordingSessionId) : null;
  if (recordingSession?.captureTimer) {
    clearInterval(recordingSession.captureTimer);
    await captureAutomationRecordingTail(recordingSession);
    await ensureRecordingFramesCoverElapsedTime(recordingSession);
  }
  let actionSidecarError: unknown = null;
  if (recordingSessionId && recordingSessions.has(recordingSessionId)) {
    if (recordingSession) {
      await writeRecordingStepTimingSidecarBestEffort(
        recordingSession,
        source,
        stepTimings,
        result.exitReason === "completed"
          ? "completed"
          : result.exitReason === "failed"
            ? "failed"
            : "partial",
      );
      try {
        await writeRecordingActionsSidecarBestEffort(recordingSession, actionEvents, {
          cursorMotionPreset: executionProfile.cursorMotionPreset,
        });
      } catch (error) {
        actionSidecarError = error;
      }
    }
    await stopRecording(
      { id: recordingSessionId },
      {
        kind: "complete",
        automation: {
          exit_reason: actionSidecarError ? "failed" : result.exitReason,
          total_steps: commands.length,
          succeeded: result.succeeded,
          failed: actionSidecarError ? Math.max(1, result.failed) : result.failed,
          failed_ordinal: result.failedOrdinal,
        },
      },
    );
  }
  if (actionSidecarError) throw actionSidecarError;
  sendChannel(sender, onEvent, {
    json: JSON.stringify({
      type: "story_ended",
      status: {
        total_steps: commands.length,
        succeeded: result.succeeded,
        failed: result.failed,
        duration_ms: result.durationMs,
      },
    }),
  });
  return null;
}

export function commandSupportsFallback(command: ParsedCommand | undefined): boolean {
  return Boolean(command && FALLBACK_TARGET_VERBS.includes(command.verb));
}

export function commandContributesCursorEvent(command: ParsedCommand | undefined): boolean {
  return Boolean(command && cursorCommandPolicy(command.verb).contributesActionEvent);
}

export function selectorSummary(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const target = record as { kind?: unknown; value?: unknown };
  const kind = typeof target.kind === "string" ? target.kind : "target";
  if (typeof target.value === "string") return `${kind}:${target.value}`;
  if (target.value && typeof target.value === "object") {
    const value = target.value as { role?: unknown; name?: unknown };
    if (typeof value.role === "string" && typeof value.name === "string") {
      return `${kind}:${value.role} "${value.name}"`;
    }
  }
  return kind;
}

export async function readTargetsForStory(storyPath: string): Promise<RuntimeTargetSidecar> {
  const raw = await readJson<unknown>(targetsPathFor(storyPath), {
    version: 1,
    steps: {},
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: 0, steps: {} };
  }
  const targets = raw as { version?: unknown; steps?: unknown };
  const version = Number(targets.version);
  const rawSteps =
    targets.steps && typeof targets.steps === "object" && !Array.isArray(targets.steps)
      ? (targets.steps as Record<string, unknown>)
      : {};
  const steps = Object.fromEntries(
    Object.entries(rawSteps).map(([stepId, value]) => [
      stepId,
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { primary?: unknown; fallbacks?: unknown[] })
        : { primary: value },
    ]),
  );
  return {
    version: Number.isSafeInteger(version) ? version : 0,
    steps,
  };
}

export async function writeTargetsForStory(
  storyPath: string,
  targets: { version: number; steps: Record<string, unknown> },
): Promise<void> {
  const targetsPath = targetsPathFor(storyPath);
  const tempPath = `${targetsPath}.tmp.${process.pid}`;
  await fs.writeFile(tempPath, JSON.stringify({ ...targets, version: 1 }, null, 2), "utf8");
  await fs.rename(tempPath, targetsPath);
}

export async function simulatorStartCommand(
  args: Record<string, unknown>,
  sender: WebContents,
): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  const channelId = channelIdFrom(args.channel);
  const storyPath = String(args.storyPath ?? "");
  const storySource = String(args.storySource ?? "");
  const streamId = String(args.streamId ?? "");
  const commands = parsedCommands(storySource);
  const totalSteps = commands.length;
  const frames = new Map<number, SimulatorStepFrame>();
  simulatorSessions.set(id, {
    id,
    sender,
    channelId,
    storyPath,
    commands,
    frames,
    totalSteps,
    cancelled: false,
  });
  sendChannel(sender, channelId, {
    type: "started",
    session_id: id,
    run_id: runId,
    total_steps: totalSteps,
  });
  const stopAfter = Number(args.stopAfterOrdinal ?? 0);
  const targets = storyPath ? await readTargetsForStory(storyPath) : { version: 1, steps: {} };
  const session = simulatorSessions.get(id);
  const preview = streamId ? authorPreviewSessions.get(streamId) : null;
  if (!session || !preview || preview.window.isDestroyed()) {
    const message = streamId
      ? `author preview ${streamId} not found for simulator run`
      : "author preview stream id is required for simulator run";
    void hostLog("warn", "simulator_start failed", {
      stream_id: streamId || "missing",
      story_path: storyPath,
      command_count: totalSteps,
      reason: message,
    });
    sendChannel(sender, channelId, {
      type: "failed",
      ordinal: 1,
      error_message: message,
    });
    return id;
  }

  const frameDir = path.join(userDataPath("simulator-runs"), runId, "frames");
  await fs.mkdir(frameDir, { recursive: true });
  void hostLog("info", "simulator_start", {
    stream_id: streamId,
    story_path: storyPath,
    command_count: totalSteps,
    app_url: storyAppUrl(storySource) ?? "",
    browser_window_id: preview.window.id,
    frame_dir: frameDir,
  });
  const result = await runStoryCommandsInBrowser({
    contents: preview.window.webContents,
    commands,
    projectFolder: String(args.projectFolder ?? app.getPath("userData")),
    storySource,
    targets,
    stopAfter,
    frameDir,
    failureFrameDir: path.join(frameDir, "diagnostics"),
    executionProfile: storyBrowserExecutionProfile(),
    shouldCancel: () => !simulatorSessions.has(id) || Boolean(simulatorSessions.get(id)?.cancelled),
    hooks: {
      onStepStarted: (ordinal) => {
        sendChannel(sender, channelId, { type: "step_started", ordinal });
      },
      onFrameCaptured: (ordinal, frame) => {
        const current = simulatorSessions.get(id);
        if (current) current.frames.set(ordinal, frame);
        sendChannel(sender, channelId, {
          type: "frame_captured",
          ordinal,
          frame,
        });
        void hostLog("info", "frame_captured", {
          run_id: runId,
          ordinal,
          screenshot_path: frame.screenshot_path ?? "",
        });
      },
      onStepFailed: (ordinal, error, screenshotPath) => {
        sendChannel(sender, channelId, {
          type: "failed",
          ordinal,
          error_message: error instanceof Error ? error.message : String(error),
          screenshot_path: screenshotPath ?? undefined,
          diagnostics: automationFailureDiagnostics(error),
        });
      },
    },
  });
  if (result.exitReason === "cancelled") {
    return id;
  }
  if (result.pausedOrdinal != null && result.failed === 0) {
    sendChannel(sender, channelId, {
      type: "paused",
      ordinal: result.pausedOrdinal,
    });
  } else if (result.failed === 0) {
    sendChannel(sender, channelId, {
      type: "completed",
      succeeded: result.succeeded,
      failed: result.failed,
    });
  } else {
    void hostLog("warn", "simulator_start failed during command execution", {
      stream_id: streamId,
      story_path: storyPath,
      succeeded: result.succeeded,
      failed: result.failed,
    });
  }
  return id;
}

export async function simulatorPromoteFallback(sessionId: string, ordinal: number): Promise<null> {
  const session = simulatorSessions.get(sessionId);
  if (!session) throw new Error(`simulator session ${sessionId} not found`);
  const frame = session.frames.get(ordinal);
  if (!frame) throw new Error(`no captured frame for ordinal ${ordinal}`);
  if (frame.match_kind !== "fuzzy") {
    throw new Error("promote-to-fallback is only valid on fuzzy matches");
  }

  const command = session.commands[ordinal - 1];
  if (!commandSupportsFallback(command)) {
    throw new Error("command has no selector target - cannot promote");
  }
  if (!command.step_id) {
    throw new Error("command has no step_id - cannot promote");
  }
  if (!session.storyPath) {
    throw new Error("storyPath is required to promote fallback");
  }

  const targets = await readTargetsForStory(session.storyPath);
  const stepValue = targets.steps[command.step_id];
  const stepTargets =
    stepValue && typeof stepValue === "object" && !Array.isArray(stepValue)
      ? (stepValue as { primary?: unknown; fallbacks?: unknown[] })
      : null;
  const [promoted, ...remainingFallbacks] = Array.isArray(stepTargets?.fallbacks)
    ? stepTargets.fallbacks
    : [];
  if (!stepTargets?.primary || !promoted) {
    throw new Error(`no fallback target recorded for step ${command.step_id}`);
  }

  targets.steps[command.step_id] = {
    primary: normalizedTargetRecord(promoted),
    fallbacks: [
      normalizedTargetRecord(stepTargets.primary),
      ...remainingFallbacks.map(normalizedTargetRecord),
    ],
  };
  await writeTargetsForStory(session.storyPath, targets);
  session.frames.set(ordinal, {
    ...frame,
    match_kind: "primary",
    matched_selector: selectorSummary(promoted),
  });
  return null;
}

export function nullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : String(value);
}

export function dryRunStep(raw: unknown, index: number): DryRunStep {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const stepArgs =
    record.args && typeof record.args === "object" ? (record.args as Record<string, unknown>) : {};
  return {
    id: String(record.id ?? `step-${index + 1}`),
    verb: String(record.verb ?? "step"),
    target: nullableString(record.target ?? stepArgs.target ?? stepArgs.selector ?? stepArgs.url),
    value: nullableString(record.value ?? stepArgs.value ?? stepArgs.text),
  };
}

export function dryRunChannelId(args: Record<string, unknown>): number | null {
  return channelIdFrom(args.channel) ?? channelIdFrom(args.onEvent);
}

export function sendDryRunSummary(session: DryRunSession): void {
  sendChannel(session.sender, session.channelId, {
    kind: "Summary",
    summary: {
      total: session.steps.length,
      passed: session.passed,
      failed: session.failed,
      totalMs: session.totalMs,
    },
  });
}

export function scheduleDryRunStep(session: DryRunSession): void {
  if (session.cancelled || session.sender.isDestroyed()) {
    dryRunSessions.delete(session.id);
    return;
  }
  if (session.index >= session.steps.length) {
    sendDryRunSummary(session);
    dryRunSessions.delete(session.id);
    return;
  }

  const step = session.steps[session.index];
  const started = Date.now();
  sendChannel(session.sender, session.channelId, {
    kind: "Running",
    step_id: step.id,
  });
  session.timer = setTimeout(() => {
    const current = dryRunSessions.get(session.id);
    if (!current || current.cancelled) return;
    const durationMs = Math.max(1, Date.now() - started);
    current.totalMs += durationMs;
    current.passed += 1;
    sendChannel(current.sender, current.channelId, {
      kind: "Pass",
      step_id: step.id,
      duration_ms: durationMs,
      fallback_chain: [],
    });
    current.index += 1;
    scheduleDryRunStep(current);
  }, 25);
  session.timer.unref?.();
}

export function dryRunStart(args: Record<string, unknown>, sender: WebContents): string {
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  if (rawSteps.length === 0) {
    throw new Error("dry-run requires at least one step");
  }

  const id = randomUUID();
  const steps = rawSteps.map(dryRunStep);
  const session: DryRunSession = {
    id,
    sender,
    channelId: dryRunChannelId(args),
    steps,
    index: 0,
    passed: 0,
    failed: 0,
    totalMs: 0,
    timer: null,
    cancelled: false,
  };
  dryRunSessions.set(id, session);
  for (const step of steps) {
    sendChannel(sender, session.channelId, {
      kind: "Queued",
      step_id: step.id,
    });
  }
  scheduleDryRunStep(session);
  return id;
}

export function dryRunCancel(taskId: string): null {
  const session = dryRunSessions.get(taskId);
  if (!session) return null;
  session.cancelled = true;
  if (session.timer) clearTimeout(session.timer);
  for (let index = session.index; index < session.steps.length; index += 1) {
    sendChannel(session.sender, session.channelId, {
      kind: "Skipped",
      step_id: session.steps[index].id,
    });
  }
  sendDryRunSummary(session);
  dryRunSessions.delete(taskId);
  return null;
}

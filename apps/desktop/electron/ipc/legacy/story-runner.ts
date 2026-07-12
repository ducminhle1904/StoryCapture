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
  recordingActionsFromSession,
  writeActionsSidecarAtomic,
} from "../action-timeline";
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
  InteractionReadinessError,
  observeInteractionTarget,
  waitForInteractionReadiness,
} from "../interaction-readiness";
import { readJson } from "../json-store";
import { sameNavigationUrl } from "../navigation-url";
import { userDataPath } from "../paths";
import { RecordingPauseCancelledError } from "../recording-pause-gate";
import {
  setSimulatorTargetValueIncrementalScript,
  setSimulatorTargetValueScript,
} from "../simulator-dom";
import { ensureTargetVisible, executeControlledScroll } from "../smooth-scroll";
import { type ParsedCommand, parsedCommands } from "../story-parser";
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
import { stopRecording } from "./recording";
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
const CURSOR_INTERACTION_VERBS = ["click", "type", "hover", "select"];
const FRAME_SYNC_FALLBACK_TIMEOUT_MS = 500;

async function requestFrameCommitOutcome(
  requestFrameCommit: (() => Promise<FrameSyncOutcome>) | undefined,
): Promise<FrameSyncOutcome | null> {
  if (!requestFrameCommit) return null;
  try {
    return await requestFrameCommit();
  } catch {
    return { status: "degraded", reason: "frame_capture_failed" };
  }
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
  } = {},
): Promise<ParsedCommandResult> {
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
    options.onInputSideEffect?.("text_start");
    const didWrite = await contents.executeJavaScript(valueScript);
    options.onInputSideEffect?.("text_end");
    options.onInputSideEffect?.("action");
    if (!didWrite) {
      throw new Error(
        `target is not editable for ${command.verb}: ${selectorSummary(command.target)}`,
      );
    }
    return { cursor: center, target };
  }
  if (command.verb === "upload") {
    throw new Error("upload command is not supported by the Electron browser runner yet");
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
  return commandContributesCursorEvent(command);
}

async function resolveCommandTarget(
  contents: WebContents,
  command: ParsedCommand,
): Promise<ActionTarget | null> {
  if (!command.target) return null;
  return resolveElementTarget(contents, command.target, command.target_nth);
}

function commandRequiresEnabledTarget(command: ParsedCommand): boolean {
  return command.verb === "click" || command.verb === "type" || command.verb === "select";
}

async function observeReadyCommandTarget(options: StoryBrowserRunOptions, command: ParsedCommand) {
  if (!command.target) return { status: "not_ready", reason: "not_found" } as const;
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
      if (options.pauseGate) return options.pauseGate.waitForDelay(durationMs);
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
    commandGetsPreActionPacing(command) ||
    command.verb === "wait-for-visible" ||
    command.verb === "assert-visible"
  );
}

async function ensureReadyCommandTarget(
  options: StoryBrowserRunOptions,
  command: ParsedCommand,
  recordingClockMs: () => number,
): Promise<{
  target: ActionTarget;
  scrollTiming: ActionScrollTiming | null;
}> {
  const result = await ensureTargetVisible({
    contents: options.contents,
    target: command.target,
    targetNth: command.target_nth,
    selector: targetSelector(command.target),
    observe: () => observeReadyCommandTarget(options, command),
    wait: async (durationMs) => {
      if (options.pauseGate) return options.pauseGate.waitForDelay(durationMs);
      await waitMs(durationMs);
      return true;
    },
    shouldCancel: options.shouldCancel,
    now: recordingClockMs,
  });
  return {
    target: result.target,
    scrollTiming: result.scrollTiming
      ? {
          start_ms: result.scrollTiming.startedAtMs,
          end_ms: result.scrollTiming.endedAtMs,
          duration_ms: result.scrollTiming.durationMs,
        }
      : null,
  };
}

function commandUsesBrowserCursorPath(command: ParsedCommand): boolean {
  return command.verb === "click" || command.verb === "hover";
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
  const shouldInjectPath =
    executionProfile.injectCursorPath !== false && commandUsesBrowserCursorPath(command);
  if (!shouldInjectPath) {
    if (plan.preActionDelayMs > 0) await waitForRecordingDelay(pauseGate, plan.preActionDelayMs);
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
  before: ActionTarget;
  after: ActionTarget;
  thresholdPx: number;
}): void {
  const deltaPx = targetCenterDeltaPx(input.before, input.after);
  if (deltaPx <= input.thresholdPx) return;
  void hostLog("warn", "cursor_target_shifted_before_input", {
    ordinal: input.ordinal,
    step_id: input.command.step_id ?? null,
    verb: input.command.verb,
    delta_px: Math.round(deltaPx * 100) / 100,
    threshold_px: input.thresholdPx,
  });
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

export async function runStoryCommandsInBrowser(options: StoryBrowserRunOptions): Promise<{
  succeeded: number;
  failed: number;
  pausedOrdinal: number | null;
  exitReason: StoryBrowserRunExitReason;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const recordingClockMs = options.recordingClockMs ?? (() => Math.max(0, Date.now() - startedAt));
  const executionProfile = options.executionProfile ?? storyBrowserExecutionProfile();
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
    const command = options.commands[index];
    lastOrdinal = ordinal;
    options.hooks?.onStepStarted?.(ordinal, command);
    const stepStartedAt = Date.now();
    const stepStartedClockMs = recordingClockMs();
    try {
      if (executionProfile.captureRecordingFrames) {
        invalidateAuthorPreviewPaintForContents(options.contents);
      }
      const isPacedCommand = commandGetsPreActionPacing(command);
      const landmarkEventId = `${ordinal}:${command.step_id ?? command.verb}`;
      let landmarkStarted = false;
      const visibility = commandUsesVisibilityPipeline(command)
        ? await ensureReadyCommandTarget(options, command, recordingClockMs)
        : null;
      let resolvedTarget = visibility
        ? visibility.target
        : await resolveCommandTarget(options.contents, command);
      const scrollTiming = visibility?.scrollTiming ?? null;
      let cursorPlan: CursorActionTimingPlan | null = null;
      let cursorStartedClockMs = recordingClockMs();
      if (pacingSize && previousCursor && resolvedTarget && isPacedCommand) {
        cursorStartedClockMs = recordingClockMs();
        options.actionLandmarks?.begin(landmarkEventId, {
          delivery:
            command.verb === "type" || command.verb === "select"
              ? "virtual_only"
              : "browser_injected",
          point: previousCursor,
          expectsPresentation: command.verb !== "hover",
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
            command,
            ordinal,
            plan: cursorPlan,
            executionProfile,
            pauseGate: options.pauseGate,
            observeTarget: () => observeReadyCommandTarget(options, command),
            targetShiftThresholdPx: executionProfile.targetStabilityThresholdPx ?? 8,
            onCursorSample: (point) =>
              options.actionLandmarks?.updateCursor(landmarkEventId, point),
          });
          const targetAfterPacing =
            pacing.shiftedTarget ?? (await resolveReadyCommandTarget(options, command));
          cursorTargetShiftWarning({
            command,
            ordinal,
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
            void hostLog("warn", "recording_frame_sync_degraded_before_input", {
              ordinal,
              step_id: command.step_id ?? null,
              verb: command.verb,
              barrier: "cursor_arrival",
              reason: arrivalOutcome.reason,
              ...captureStateSnapshot(options.captureStateSnapshot),
            });
            options.actionLandmarks.discard(landmarkEventId);
            landmarkStarted = false;
          }
        }
      }
      await waitForRecordingDelay(options.pauseGate, 0);
      const actionStartedAt = Date.now();
      const actionStartedClockMs = recordingClockMs();
      const result = await executeParsedCommand(options.contents, command, options.projectFolder, {
        executionProfile,
        resolvedTarget,
        pauseGate: options.pauseGate,
        shouldCancel: options.shouldCancel,
        beforeInputSideEffect: landmarkStarted
          ? () => options.actionLandmarks?.armPresentation(landmarkEventId)
          : undefined,
        onInputSideEffect: landmarkStarted
          ? (kind) => options.actionLandmarks?.markInput(landmarkEventId, kind)
          : undefined,
      });
      if (landmarkStarted && command.verb !== "hover") {
        await options.actionLandmarks?.waitForPresentation(landmarkEventId, 500);
      }
      const actionDurationMs = isPacedCommand
        ? actionStartedAt - stepStartedAt
        : Date.now() - stepStartedAt;
      const settleDelayMs = executionProfile.settleDelayForCommand(command);
      if (settleDelayMs > 0) await waitForRecordingDelay(options.pauseGate, settleDelayMs);
      const stepEndedClockMs = recordingClockMs();
      const durationMs = Math.max(0, stepEndedClockMs - stepStartedClockMs);
      const explicitTiming =
        cursorPlan && isPacedCommand
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
      if (pacingSize && result.target && commandContributesCursorEvent(command)) {
        previousCursor = cursorPointForTarget(result.target, pacingSize);
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
      failed += 1;
      exitReason = "failed";
      const screenshotPath = await captureFailureFrameBestEffort(
        options.contents,
        options.failureFrameDir,
        ordinal,
      );
      options.hooks?.onStepFailed?.(ordinal, error, screenshotPath);
      break;
    }
  }
  if (exitReason === "completed" && limit < options.commands.length) {
    exitReason = "paused";
  }

  return {
    succeeded,
    failed,
    pausedOrdinal: exitReason === "paused" ? lastOrdinal || limit : null,
    exitReason,
    durationMs: Date.now() - startedAt,
  };
}

export async function writeRecordingActionsSidecarBestEffort(
  session: RecordingSession,
  events: ActionTimelineEvent[],
  options: {
    cursorMotionPreset?: ActionCursorTiming["motion_preset"];
    strict?: boolean;
  } = {},
): Promise<void> {
  if (events.length === 0) return;
  const file = actionsSidecarPath(session.outputPath);
  const syncMode = resolveCursorSyncMode();
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
      void hostLog("info", "recording_cursor_sync_shadow", {
        session_id: session.id,
        event_count: events.length,
        authoritative_event_count: authoritativeEvents,
        invalid_ordering_event_count: invalidOrderingEvents,
      });
    }
    await writeActionsSidecarAtomic(
      file,
      recordingActionsFromSession(session, events, {
        cursorMotionPreset: options.cursorMotionPreset,
        version: syncMode === "unified" ? 3 : 2,
      }),
    );
  } catch (error) {
    void hostLog("warn", "recording_actions_sidecar_write_failed", {
      session_id: session.id,
      recording_path: session.outputPath,
      sidecar_path: file,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (options.strict || syncMode === "unified") throw error;
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
  const projectFolder = String(args.projectFolder ?? app.getPath("userData"));
  const commands = parsedCommands(source);
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
  const targets = { version: 1, steps: {} };
  const recordingSessionAtLaunch = recordingSessionId
    ? recordingSessions.get(recordingSessionId)
    : null;
  const actionEvents: ActionTimelineEvent[] = [];
  const actionStepStartMs = new Map<number, number>();
  const actionRunStartedAt = recordingSessionAtLaunch?.startedAt ?? Date.now();
  const executionProfile = storyBrowserExecutionProfile({
    captureRecordingFrames: Boolean(recordingSessionId),
    captureSize: recordingSessionAtLaunch
      ? {
          width: recordingSessionAtLaunch.width,
          height: recordingSessionAtLaunch.height,
        }
      : undefined,
  });
  const failureFrameDir = userDataPath("automation-runs", randomUUID(), "diagnostics");
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
      recordingClockMs: recordingSessionAtLaunch
        ? () => recordingFrameClockMs(recordingSessionAtLaunch)
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
        ? () => recordingSessions.get(recordingSessionAtLaunch.id) !== recordingSessionAtLaunch
        : undefined,
      hooks: {
        onStepStarted: (ordinal, command) => {
          if (recordingSessionId) {
            actionStepStartMs.set(ordinal, Math.max(0, Date.now() - actionRunStartedAt));
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
          const fallbackStepEndedAtMs = Math.max(0, Date.now() - actionRunStartedAt);
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
          if (recordingSessionId && stepResult.target && commandContributesCursorEvent(command)) {
            actionEvents.push(
              actionTimelineEventFromStep({
                ordinal,
                command,
                stepStartedAtMs,
                actionAtMs,
                stepEndedAtMs,
                target: stepResult.target,
                pointer: stepResult.pointer ?? undefined,
                scrollTiming: timing?.scrollTiming ?? null,
                cursorTiming: timing?.cursorTiming ?? null,
                inputTiming: timing?.inputTiming ?? null,
                landmarks: timing?.landmarks ?? null,
              }),
            );
          }
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_succeeded",
              ordinal,
              step_id: command.step_id ?? null,
              duration_ms: durationMs,
              cursor_x: stepResult.cursor?.x ?? 0,
              cursor_y: stepResult.cursor?.y ?? 0,
              matched_selector: targetSelector(command.target),
              matched_bbox: stepResult.target?.bounds ?? null,
              match_kind: stepResult.cursor ? "primary" : "none",
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
          actionStepStartMs.delete(ordinal);
          const diagnostics = automationFailureDiagnostics(error);
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_failed",
              ordinal,
              attempts: diagnostics ? [diagnostics] : [],
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
  if (recordingSessionId && recordingSessions.has(recordingSessionId)) {
    await stopRecording({ id: recordingSessionId });
    if (recordingSession) {
      await writeRecordingActionsSidecarBestEffort(recordingSession, actionEvents, {
        cursorMotionPreset: executionProfile.cursorMotionPreset,
      });
    }
  }
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
  return Boolean(command && CURSOR_INTERACTION_VERBS.includes(command.verb));
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

export async function readTargetsForStory(storyPath: string): Promise<{
  version: number;
  steps: Record<string, { primary?: unknown; fallbacks?: unknown[] }>;
}> {
  const targets = await readJson<{
    version: number;
    steps: Record<string, { primary?: unknown; fallbacks?: unknown[] }>;
  }>(targetsPathFor(storyPath), { version: 1, steps: {} });
  return { version: 1, steps: targets.steps ?? {} };
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
  const stepTargets = targets.steps[command.step_id];
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

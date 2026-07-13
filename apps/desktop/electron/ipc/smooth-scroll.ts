import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

import type { ActionTarget } from "./action-timeline";
import {
  type InteractionObservation,
  InteractionReadinessError,
  type InteractionReadinessReason,
  waitForInteractionReadiness,
} from "./interaction-readiness";
import { simulatorTargetLookupHelpersScript } from "./simulator-dom";
import type { TargetVisibilityDiagnostics } from "./target-visibility";

const MIN_SCROLL_DURATION_MS = 300;
const MAX_SCROLL_DURATION_MS = 900;
const SCROLL_FRAME_MS = 16;
const STABILITY_TIMEOUT_MS = 1_000;
const MAX_OVERLAY_REPOSITIONS = 3;

export interface SmoothScrollTiming {
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
}

export interface EnsureTargetVisibleResult {
  target: ActionTarget;
  diagnostics?: TargetVisibilityDiagnostics;
  scrollTiming: SmoothScrollTiming | null;
  repositionAttempts: number;
}

export interface ExplicitScrollResult {
  scrollTiming: SmoothScrollTiming | null;
  requestedAmountPx: number;
  appliedAmountPx: number;
}

export class TargetVisibilityPhaseError extends Error {
  readonly reason: InteractionReadinessReason;
  readonly phase: "scroll" | "stability" | "overlay";
  readonly diagnostics?: TargetVisibilityDiagnostics;

  constructor(
    phase: TargetVisibilityPhaseError["phase"],
    reason: InteractionReadinessReason,
    diagnostics?: TargetVisibilityDiagnostics,
  ) {
    super(`interaction target was not ready during ${phase}: ${reason}`);
    this.name = "TargetVisibilityPhaseError";
    this.phase = phase;
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

export function easeInOutCubic(progress: number): number {
  const value = Math.max(0, Math.min(1, progress));
  return value < 0.5 ? 4 * value * value * value : 1 - (-2 * value + 2) ** 3 / 2;
}

export function smoothScrollDurationMs(distancePx: number, viewportDiagonalPx: number): number {
  const duration = 300 + (300 * Math.max(0, distancePx)) / Math.max(1, viewportDiagonalPx);
  return Math.round(Math.max(MIN_SCROLL_DURATION_MS, Math.min(MAX_SCROLL_DURATION_MS, duration)));
}

function prepareTargetScrollScript(input: {
  token: string;
  target: unknown;
  targetNth?: number;
  selector?: string | null;
  repositionAttempt: number;
}): string {
  return `
    (() => {
      ${simulatorTargetLookupHelpersScript()}
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const el = findSimulatorTarget(
        ${JSON.stringify(input.target)},
        ${JSON.stringify(input.targetNth ?? null)},
        ${JSON.stringify(input.selector ?? null)}
      );
      if (!el || !el.isConnected) return null;
      const plans = [];
      const targetRect = el.getBoundingClientRect();
      const ancestors = [];
      let ancestor = el.parentElement;
      while (ancestor) {
        const style = window.getComputedStyle(ancestor);
        const scrollableX = ["auto", "scroll", "overlay"].includes(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;
        const scrollableY = ["auto", "scroll", "overlay"].includes(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight;
        if (scrollableX || scrollableY) ancestors.push({ element: ancestor, scrollableX, scrollableY });
        ancestor = ancestor.parentElement;
      }
      const scrollingElement = document.scrollingElement || document.documentElement;
      ancestors.push({ element: scrollingElement, scrollableX: true, scrollableY: true, document: true });
      const overlayOffset = ${JSON.stringify(input.repositionAttempt)} === 0
        ? 0
        : (${JSON.stringify(input.repositionAttempt)} % 2 === 1 ? -1 : 1) * Math.ceil(${JSON.stringify(input.repositionAttempt)} / 2) * 96;
      for (const item of ancestors) {
        const node = item.element;
        const bounds = item.document
          ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
          : node.getBoundingClientRect();
        const startX = item.document ? (window.scrollX || node.scrollLeft || 0) : node.scrollLeft;
        const startY = item.document ? (window.scrollY || node.scrollTop || 0) : node.scrollTop;
        const maxX = Math.max(0, node.scrollWidth - (item.document ? window.innerWidth : node.clientWidth));
        const maxY = Math.max(0, node.scrollHeight - (item.document ? window.innerHeight : node.clientHeight));
        const targetCenterX = targetRect.left + targetRect.width / 2;
        const targetCenterY = targetRect.top + targetRect.height / 2;
        const desiredX = item.scrollableX
          ? clamp(startX + targetCenterX - (bounds.left + bounds.width / 2), 0, maxX)
          : startX;
        const desiredY = item.scrollableY
          ? clamp(startY + targetCenterY - (bounds.top + bounds.height / 2) + overlayOffset, 0, maxY)
          : startY;
        if (Math.abs(desiredX - startX) > 0.5 || Math.abs(desiredY - startY) > 0.5) {
          plans.push({ node, document: Boolean(item.document), startX, startY, desiredX, desiredY });
        }
      }
      const registry = window.__storycaptureScrollPlans || (window.__storycaptureScrollPlans = {});
      registry[${JSON.stringify(input.token)}] = plans;
      const distance = plans.reduce((maximum, plan) => Math.max(
        maximum,
        Math.hypot(plan.desiredX - plan.startX, plan.desiredY - plan.startY)
      ), 0);
      return {
        distance,
        viewportDiagonal: Math.hypot(window.innerWidth, window.innerHeight),
        planCount: plans.length,
      };
    })()
  `;
}

function prepareExplicitScrollScript(input: {
  token: string;
  target?: unknown;
  targetNth?: number;
  selector?: string | null;
  direction: "up" | "down" | "left" | "right";
  amount: number;
  unit: "px" | "vh";
}): string {
  return `
    (() => {
      ${simulatorTargetLookupHelpersScript()}
      const target = ${input.target === undefined ? "null" : `findSimulatorTarget(${JSON.stringify(input.target)}, ${JSON.stringify(input.targetNth ?? null)}, ${JSON.stringify(input.selector ?? null)})`};
      if (${input.target === undefined ? "false" : "true"} && (!target || !target.isConnected)) return { error: "target_not_found" };
      const canScroll = (node) => {
        const style = window.getComputedStyle(node);
        return {
          x: ["auto", "scroll", "overlay"].includes(style.overflowX) && node.scrollWidth > node.clientWidth,
          y: ["auto", "scroll", "overlay"].includes(style.overflowY) && node.scrollHeight > node.clientHeight,
        };
      };
      let node = document.scrollingElement || document.documentElement;
      let documentScroller = true;
      if (target) {
        let candidate = target;
        while (candidate) {
          const axes = canScroll(candidate);
          if (axes.x || axes.y) {
            node = candidate;
            documentScroller = false;
            break;
          }
          candidate = candidate.parentElement;
        }
        if (documentScroller) return { error: "scroll_container_not_found" };
      }
      const horizontal = ${JSON.stringify(input.direction === "left" || input.direction === "right")};
      const sign = ${JSON.stringify(input.direction === "up" || input.direction === "left" ? -1 : 1)};
      const dimension = horizontal
        ? (documentScroller ? window.innerWidth : node.clientWidth)
        : (documentScroller ? window.innerHeight : node.clientHeight);
      const requestedAmount = ${JSON.stringify(input.amount)} * (${JSON.stringify(input.unit)} === "vh" ? dimension / 100 : 1);
      const startX = documentScroller ? (window.scrollX || node.scrollLeft || 0) : node.scrollLeft;
      const startY = documentScroller ? (window.scrollY || node.scrollTop || 0) : node.scrollTop;
      const maxX = Math.max(0, node.scrollWidth - (documentScroller ? window.innerWidth : node.clientWidth));
      const maxY = Math.max(0, node.scrollHeight - (documentScroller ? window.innerHeight : node.clientHeight));
      const desiredX = horizontal ? Math.max(0, Math.min(maxX, startX + sign * requestedAmount)) : startX;
      const desiredY = horizontal ? startY : Math.max(0, Math.min(maxY, startY + sign * requestedAmount));
      const registry = window.__storycaptureScrollPlans || (window.__storycaptureScrollPlans = {});
      registry[${JSON.stringify(input.token)}] = [{
        node,
        document: documentScroller,
        startX,
        startY,
        desiredX,
        desiredY,
      }];
      return {
        distance: Math.hypot(desiredX - startX, desiredY - startY),
        viewportDiagonal: Math.hypot(
          documentScroller ? window.innerWidth : node.clientWidth,
          documentScroller ? window.innerHeight : node.clientHeight
        ),
        planCount: 1,
        requestedAmount,
        appliedAmount: horizontal ? Math.abs(desiredX - startX) : Math.abs(desiredY - startY),
      };
    })()
  `;
}

function applyTargetScrollFrameScript(token: string, progress: number): string {
  return `
    (() => {
      const registry = window.__storycaptureScrollPlans || {};
      const plans = registry[${JSON.stringify(token)}];
      if (!Array.isArray(plans)) return false;
      const easeInOutCubic = ${easeInOutCubic.toString()};
      const raw = Math.max(0, Math.min(1, ${JSON.stringify(progress)}));
      const eased = easeInOutCubic(raw);
      for (const plan of plans) {
        const x = plan.startX + (plan.desiredX - plan.startX) * eased;
        const y = plan.startY + (plan.desiredY - plan.startY) * eased;
        if (plan.document) window.scrollTo(x, y);
        else plan.node.scrollTo(x, y);
      }
      if (raw >= 1) delete registry[${JSON.stringify(token)}];
      return true;
    })()
  `;
}

function cleanupTargetScrollScript(token: string): string {
  return `
    (() => {
      const registry = window.__storycaptureScrollPlans;
      if (registry) delete registry[${JSON.stringify(token)}];
    })()
  `;
}

async function waitWithCancellation(input: {
  wait: (durationMs: number) => Promise<boolean | undefined>;
  shouldCancel?: () => boolean;
  durationMs: number;
}): Promise<void> {
  if (input.shouldCancel?.()) throw new TargetVisibilityPhaseError("scroll", "detached");
  if ((await input.wait(input.durationMs)) === false) {
    throw new TargetVisibilityPhaseError("scroll", "detached");
  }
}

async function animatePreparedScroll(input: {
  contents: WebContents;
  token: string;
  durationMs: number;
  wait: (durationMs: number) => Promise<boolean | undefined>;
  shouldCancel?: () => boolean;
}): Promise<void> {
  const frames = Math.max(1, Math.ceil(input.durationMs / SCROLL_FRAME_MS));
  try {
    for (let frame = 1; frame <= frames; frame += 1) {
      await waitWithCancellation({
        wait: input.wait,
        shouldCancel: input.shouldCancel,
        durationMs: Math.min(
          SCROLL_FRAME_MS,
          input.durationMs - ((frame - 1) * input.durationMs) / frames,
        ),
      });
      await input.contents.executeJavaScript(
        applyTargetScrollFrameScript(input.token, frame / frames),
      );
    }
  } finally {
    if (!input.contents.isDestroyed()) {
      await input.contents
        .executeJavaScript(cleanupTargetScrollScript(input.token))
        .catch(() => {});
    }
  }
}

async function runPreparedScroll(input: {
  contents: WebContents;
  token: string;
  distance: number;
  viewportDiagonal: number;
  wait: (durationMs: number) => Promise<boolean | undefined>;
  shouldCancel?: () => boolean;
  now: () => number;
}): Promise<SmoothScrollTiming> {
  const durationMs = smoothScrollDurationMs(input.distance, input.viewportDiagonal);
  const startedAtMs = input.now();
  await animatePreparedScroll({
    contents: input.contents,
    token: input.token,
    durationMs,
    wait: input.wait,
    shouldCancel: input.shouldCancel,
  });
  const endedAtMs = input.now();
  return {
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
  };
}

async function waitForStableObservation(input: {
  observe: () => Promise<InteractionObservation>;
  wait: (durationMs: number) => Promise<boolean | undefined>;
  shouldCancel?: () => boolean;
  timeoutMs?: number;
}): Promise<Extract<InteractionObservation, { status: "ready" }>> {
  try {
    const result = await waitForInteractionReadiness({
      observe: input.observe,
      wait: async (durationMs) => {
        await waitWithCancellation({
          wait: input.wait,
          shouldCancel: input.shouldCancel,
          durationMs,
        });
        return true;
      },
      timeoutMs: Math.min(STABILITY_TIMEOUT_MS, input.timeoutMs ?? STABILITY_TIMEOUT_MS),
      pollIntervalMs: SCROLL_FRAME_MS,
      stableObservations: 2,
      stabilityThresholdPx: 1,
    });
    return {
      status: "ready",
      target: result.target,
      diagnostics: result.diagnostics,
    };
  } catch (error) {
    if (error instanceof TargetVisibilityPhaseError) throw error;
    if (error instanceof InteractionReadinessError) {
      throw new TargetVisibilityPhaseError("stability", error.reason, error.diagnostics);
    }
    throw error;
  }
}

export async function executeControlledScroll(input: {
  contents: WebContents;
  target?: unknown;
  targetNth?: number;
  selector?: string | null;
  direction: "up" | "down" | "left" | "right";
  amount: number;
  unit: "px" | "vh";
  wait: (durationMs: number) => Promise<boolean | undefined>;
  shouldCancel?: () => boolean;
  now?: () => number;
}): Promise<ExplicitScrollResult> {
  const token = randomUUID();
  const prepared = (await input.contents.executeJavaScript(
    prepareExplicitScrollScript({
      token,
      target: input.target,
      targetNth: input.targetNth,
      selector: input.selector,
      direction: input.direction,
      amount: input.amount,
      unit: input.unit,
    }),
  )) as {
    error?: "target_not_found" | "scroll_container_not_found";
    distance?: number;
    viewportDiagonal?: number;
    planCount?: number;
    requestedAmount?: number;
    appliedAmount?: number;
  } | null;
  if (!prepared || prepared.error === "target_not_found") {
    throw new Error("target not found for scroll");
  }
  if (prepared.error === "scroll_container_not_found") {
    throw new Error("target has no scrollable box or scrollable ancestor");
  }
  const requestedAmountPx = Math.max(0, Number(prepared.requestedAmount) || 0);
  const appliedAmountPx = Math.max(0, Number(prepared.appliedAmount) || 0);
  if (appliedAmountPx <= 0) {
    await input.contents.executeJavaScript(cleanupTargetScrollScript(token)).catch(() => {});
    return { scrollTiming: null, requestedAmountPx, appliedAmountPx };
  }
  const scrollTiming = await runPreparedScroll({
    contents: input.contents,
    token,
    distance: Number(prepared.distance) || 0,
    viewportDiagonal: Number(prepared.viewportDiagonal) || 1,
    wait: input.wait,
    shouldCancel: input.shouldCancel,
    now: input.now ?? Date.now,
  });
  return {
    scrollTiming,
    requestedAmountPx,
    appliedAmountPx,
  };
}

export async function ensureTargetVisible(input: {
  contents: WebContents;
  target: unknown;
  targetNth?: number;
  selector?: string | null;
  observe: () => Promise<InteractionObservation>;
  wait: (durationMs: number) => Promise<boolean | undefined>;
  shouldCancel?: () => boolean;
  now?: () => number;
  timeoutMs?: number;
}): Promise<EnsureTargetVisibleResult> {
  const now = input.now ?? Date.now;
  let observation = await input.observe();
  let scrollTiming: SmoothScrollTiming | null = null;
  let repositionAttempts = 0;

  if (observation.status === "ready") {
    const stable = await waitForStableObservation(input);
    return {
      target: stable.target,
      diagnostics: stable.diagnostics,
      scrollTiming,
      repositionAttempts,
    };
  }

  if (observation.reason === "detached") {
    const stable = await waitForStableObservation(input);
    return {
      target: stable.target,
      diagnostics: stable.diagnostics,
      scrollTiming,
      repositionAttempts,
    };
  }

  for (let attempt = 0; attempt <= MAX_OVERLAY_REPOSITIONS; attempt += 1) {
    if (attempt > 0) repositionAttempts = attempt;
    const token = randomUUID();
    const prepared = (await input.contents.executeJavaScript(
      prepareTargetScrollScript({
        token,
        target: input.target,
        targetNth: input.targetNth,
        selector: input.selector,
        repositionAttempt: attempt,
      }),
    )) as { distance: number; viewportDiagonal: number; planCount: number } | null;
    if (!prepared) {
      throw new TargetVisibilityPhaseError("scroll", "detached", observation.diagnostics);
    }
    if (prepared.planCount > 0) {
      scrollTiming = await runPreparedScroll({
        contents: input.contents,
        token,
        distance: prepared.distance,
        viewportDiagonal: prepared.viewportDiagonal,
        wait: input.wait,
        shouldCancel: input.shouldCancel,
        now,
      });
    } else {
      await input.contents.executeJavaScript(cleanupTargetScrollScript(token)).catch(() => {});
    }

    observation = await input.observe();
    if (observation.status === "ready") {
      const stable = await waitForStableObservation(input);
      return {
        target: stable.target,
        diagnostics: stable.diagnostics,
        scrollTiming,
        repositionAttempts,
      };
    }
    if (observation.reason !== "covered" && observation.reason !== "outside_viewport") {
      throw new TargetVisibilityPhaseError("scroll", observation.reason, observation.diagnostics);
    }
  }

  throw new TargetVisibilityPhaseError("overlay", "covered", observation.diagnostics);
}

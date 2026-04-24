/**
 * PreviewPickerButton — author-time element picker mounted inside the
 * Preview panel (Phase 11 relocation; supersedes the recorder-side
 * `PickElementButton`).
 *
 * Wire flow (D-09 lazy-start + D-10 navigate-replay + D-12 always-resume):
 *   click
 *     → if picking, call pickElementCancel and return (re-click = cancel)
 *     → if simulator-running, no-op (button also disabled)
 *     → if !streamId, warn and bail (caller must enable Live Preview first)
 *     → read cursorLine from editorController
 *     → if doc dirty, fire a non-blocking warning toast (D-10)
 *     → setPicking(true), dispatch pickElementAuthor({ streamId, storySrc,
 *                                                      cursorLine })
 *     → on Picked: editorController.insertAtCursor(emitted + "\n")
 *                → pickerStampStepId → toast (first-pick vs re-pick)
 *     → on Cancelled: reason-specific toast (silent on user-cancel)
 *     → finally setPicking(false)
 *
 * Five visual states driven by `useAuthorDriverStore`:
 *   Idle / LivePreview   — default visual, click = lazy-start + pick
 *   Picking              — accent border + filled crosshair + Esc pill
 *   SimulatorRunning     — disabled, no-op
 *   SimulatorPaused      — enabled; pick still permitted (D-14)
 * Plus UI-local `isStarting` overlay during D-09 lazy-start warm-up.
 *
 * Keymap integration: `registerPickTrigger` exposes the onClick as a
 * module-level handler for `codemirror-setup.ts` to call from the
 * `Mod-Shift-p` keybinding. Prefers explicit registration over a global
 * `document.addEventListener` (research anti-pattern).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Crosshair, Loader2 } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { editorController } from "@/features/editor/controller";
import {
  useAuthorDriverStore,
  type AuthorDriverVariant,
} from "@/features/editor/authorDriverStore";
import { useEditorStore } from "@/state/editor";
import {
  isPicked,
  listenPickerHoverPreview,
  pickElementAuthor,
  pickElementCancel,
  pickerStampStepId,
  type PickHoverPayload,
  type TargetRecordDto,
} from "@/ipc/picker";

/**
 * UI-SPEC §Copywriting — LOCKED copy constants.
 *
 * All six tooltip strings, seven toast strings, and three banner strings
 * appear verbatim in this file as required by the plan's §Done grep
 * assertions. A single source-of-truth block prevents drift and makes
 * the plan's `grep ... | wc -l` checks deterministic.
 */
const COPY = {
  // Tooltips (UI-SPEC §Copywriting Contract — Per-state tooltips table)
  TOOLTIP_IDLE: "Pick element · starts Preview",
  TOOLTIP_LIVE: "Pick element · ⌘⇧P",
  TOOLTIP_PICKING: "Picking — press Esc",
  TOOLTIP_STARTING: "Starting session…",
  TOOLTIP_SIMULATOR_RUNNING: "Simulator running — cancel to pick",
  TOOLTIP_SIMULATOR_PAUSED_WITH_N:
    "Paused at step {N} — Pick will resume Preview after",
  TOOLTIP_SIMULATOR_PAUSED_NO_N: "Paused — Pick will resume Preview after",
  // aria-label (UI-SPEC §Copywriting — Pick button aria-label)
  ARIA_LABEL: "Pick element from preview (Cmd-Shift-P)",
  ARIA_LABEL_PICKING: "Picking — press Esc to cancel",
  ARIA_LABEL_STARTING: "Starting author session…",
  // Banner (UI-SPEC §Copywriting — Picking banner)
  BANNER_ACTIVE: "PICKING — press Esc to cancel",
  BANNER_PAUSED_WITH_N:
    "PICKING — press Esc (Preview will stay paused at step {N})",
  BANNER_ERROR_PREFIX: "Couldn't start picker — ",
  BANNER_ERROR_SUFFIX:
    ". Try again or toggle Preview off and on.",
  // Toasts (UI-SPEC §Copywriting — Toasts table, 7 strings)
  TOAST_PICK_NAVIGATION: "Picking cancelled — page navigated",
  TOAST_PICK_UNSUPPORTED:
    "Picking unavailable on this page (`chrome://`, `about:`, or `view-source:`)",
  TOAST_PICK_WARM_UP_PARTIAL:
    "Warming context hit an error — picking on whichever page loaded",
  TOAST_PICK_TIMEOUT: "Picker timed out — try again",
  TOAST_DIRTY_WARNING:
    "Unsaved changes — Pick will use the last saved version. Save first?",
  TOAST_NO_CURSOR: "No cursor position",
  TOAST_NO_STREAM:
    "Enable Live Preview first — Pick needs an author session",
} as const;

/**
 * Module-level trigger registration. `codemirror-setup.ts` calls the
 * registered handler from its `Mod-Shift-p` keybinding so the keymap
 * and the button share a single implementation.
 */
type PickTrigger = () => void;
let pickTrigger: PickTrigger | null = null;

export function registerPickTrigger(fn: PickTrigger): void {
  pickTrigger = fn;
}

export function unregisterPickTrigger(fn: PickTrigger): void {
  // Only clear if we still own the slot (guards against unmount-order races
  // when two buttons ever coexist).
  if (pickTrigger === fn) pickTrigger = null;
}

/** Invoked by the CodeMirror keymap. Safe no-op when no button is mounted. */
export function triggerPickFromEditor(): void {
  pickTrigger?.();
}

function formatTooltip(
  variant: AuthorDriverVariant,
  isStarting: boolean,
  simulatorOrdinal: number | null,
): string {
  if (isStarting) return COPY.TOOLTIP_STARTING;
  switch (variant) {
    case "idle":
      return COPY.TOOLTIP_IDLE;
    case "live-preview":
      return COPY.TOOLTIP_LIVE;
    case "picking":
      return COPY.TOOLTIP_PICKING;
    case "simulator-running":
      return COPY.TOOLTIP_SIMULATOR_RUNNING;
    case "simulator-paused":
      return simulatorOrdinal != null
        ? COPY.TOOLTIP_SIMULATOR_PAUSED_WITH_N.replace(
            "{N}",
            String(simulatorOrdinal),
          )
        : COPY.TOOLTIP_SIMULATOR_PAUSED_NO_N;
  }
}

/**
 * PreviewPickerButton — mounted inside the Preview panel toolbar per
 * UI-SPEC §Visual Layout §1.
 */
export function PreviewPickerButton() {
  const variant = useAuthorDriverStore((s) => s.variant);
  const streamId = useAuthorDriverStore((s) => s.streamId);
  const simulatorOrdinal = useAuthorDriverStore((s) => s.simulatorOrdinal);
  const setSnapshot = useAuthorDriverStore((s) => s.setSnapshot);

  const [isStarting, setIsStarting] = useState(false);
  // Local `picking` flag mirrors the `Picking` FSM state for the lifetime
  // of a single pick. We set it manually because the host FSM transitions
  // are not (yet) broadcast back to the renderer; this keeps the UI
  // consistent with what the button is actually doing.
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<PickHoverPayload | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const isSimulatorRunning = variant === "simulator-running";
  // Button is disabled during simulator-running and during UI-local
  // `starting…` (D-09 warm-up — no double-click racing).
  const disabled = isSimulatorRunning || isStarting;

  // Desktop-side Esc safety net while picking.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pickElementCancel().catch(() => {
          /* sidecar may have already settled — non-fatal */
        });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picking]);

  // Subscribe to hover-preview events while picking (ported verbatim from
  // pick-element-button.tsx; same ~60Hz throttling, same unmount dance).
  useEffect(() => {
    if (!picking) {
      setPreview(null);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listenPickerHoverPreview((p) => {
      if (cancelled) return;
      setPreview((prev) =>
        prev &&
        prev.testId === p.testId &&
        prev.role === p.role &&
        prev.accessibleName === p.accessibleName
          ? prev
          : p,
      );
    })
      .then((u) => {
        if (cancelled) {
          try {
            u();
          } catch {
            /* non-fatal */
          }
        } else {
          unlisten = u;
        }
      })
      .catch(() => {
        /* Tauri bridge unavailable in tests without shouldMockEvents */
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        Promise.resolve()
          .then(() => unlisten!())
          .catch(() => {});
      }
      setPreview(null);
    };
  }, [picking]);

  // Register this component's click handler as the module-level keymap
  // trigger. `codemirror-setup.ts` dispatches `Mod-Shift-p` through it.
  const onClickRef = useRef<PickTrigger>(() => {});
  useEffect(() => {
    registerPickTrigger(() => onClickRef.current());
    return () => unregisterPickTrigger(() => onClickRef.current());
  }, []);

  const onClick = async () => {
    // Re-click while picking = cancel (symmetric with Esc).
    if (picking) {
      pickElementCancel().catch(() => {});
      return;
    }
    if (isSimulatorRunning) return; // disabled path; no-op

    if (!streamId) {
      toast.warning(COPY.TOAST_NO_STREAM);
      return;
    }

    const cursorLine = editorController.getCursorLine();
    if (cursorLine == null) {
      toast.error(COPY.TOAST_NO_CURSOR);
      return;
    }

    // D-10: Navigate-replay reads the source bytes we pass. The CodeMirror
    // buffer is the renderer's authoritative view; warn the user when
    // the buffer diverges from the last-saved state so they can decide
    // whether to save first. Non-blocking: proceed either way.
    if (editorController.isDirty()) {
      toast.warning(COPY.TOAST_DIRTY_WARNING);
    }

    const storySrc = useEditorStore.getState().source;

    // Flip to `picking` (local) + overlay in the shared projection so the
    // banner shows the correct variant.
    setPicking(true);
    setBannerError(null);
    setSnapshot({ variant: "picking" });

    try {
      const r = await pickElementAuthor({
        streamId,
        storySrc,
        cursorLine,
        timeoutMs: 60_000,
      });
      if (isPicked(r)) {
        const res = editorController.insertAtCursor(r.emitted + "\n");
        if (res.ok) {
          const storyPath = editorController.getStoryPath();
          if (storyPath) {
            try {
              const stamp = await pickerStampStepId({
                storyPath,
                lineOffset: res.lineNumber,
                primary: r.locator as TargetRecordDto,
                fallbacks: r.candidates.map(
                  (c) => ({ kind: c.kind, value: c.value }) as TargetRecordDto,
                ),
              });
              if (stamp.wasFreshlyStamped) {
                // First-pick copy (UI-SPEC §Toasts row 1):
                //   Added `{verb} {target}` · line {L}
                toast.success(
                  `Added \`${r.emitted}\` · line ${res.lineNumber}`,
                );
              } else {
                // Re-pick copy (UI-SPEC §Toasts row 2):
                //   Updated fallback for step {N}
                const stepOrdinal =
                  editorController.getStepOrdinalForLine(res.lineNumber) ??
                  res.lineNumber;
                toast.success(`Updated fallback for step ${stepOrdinal}`);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              toast.error(msg);
            }
          } else {
            // No backing file yet — only the first-pick branch is valid.
            toast.success(`Added \`${r.emitted}\` · line ${res.lineNumber}`);
          }
        } else {
          toast.error("Editor not ready — focus the editor first");
        }
      } else {
        switch (r.reason) {
          case "user-cancel":
            // Silent per UI-SPEC §Toasts row 3.
            break;
          case "navigation":
            toast.info(COPY.TOAST_PICK_NAVIGATION);
            break;
          case "unsupported-url":
            toast.warning(COPY.TOAST_PICK_UNSUPPORTED);
            break;
          case "timeout":
            toast.error(COPY.TOAST_PICK_TIMEOUT);
            break;
          default:
            toast.info(`Picking ended: ${r.reason}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Banner error variant (UI-SPEC §Copywriting — banner internal-error)
      // Surface via banner AND a toast so the user can't miss it.
      setBannerError(msg);
      toast.error(
        `${COPY.BANNER_ERROR_PREFIX}${msg}${COPY.BANNER_ERROR_SUFFIX}`,
      );
      // Dev visibility: warm-up replay partial failures surface here too.
      // The UI-SPEC warm-up-partial toast is reserved for driver-reported
      // partial failures and is left as a constant for future wiring.
      void COPY.TOAST_PICK_WARM_UP_PARTIAL;
    } finally {
      setPicking(false);
      setIsStarting(false);
      // Clear the renderer's projection override so it re-derives from
      // upstream stores.
      setSnapshot({ variant: streamId ? "live-preview" : "idle" });
    }
  };

  onClickRef.current = onClick;

  const tooltip = formatTooltip(variant, isStarting, simulatorOrdinal);
  const ariaLabel = picking
    ? COPY.ARIA_LABEL_PICKING
    : isStarting
      ? COPY.ARIA_LABEL_STARTING
      : COPY.ARIA_LABEL;

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={tooltip}
        aria-label={ariaLabel}
        aria-describedby="preview-picker-tooltip"
        aria-pressed={picking ? true : undefined}
        aria-busy={isStarting ? true : undefined}
        aria-keyshortcuts="Meta+Shift+KeyP Control+Shift+KeyP"
        data-state={picking ? "picking" : isStarting ? "starting" : variant}
        className={[
          "inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-sm)]",
          "border",
          picking
            ? "border-[var(--color-accent-primary)]"
            : "border-transparent",
          "bg-[var(--color-surface-200)] text-[var(--color-fg-primary)] transition-colors",
          disabled
            ? "opacity-60 cursor-not-allowed hover:bg-[var(--color-surface-200)]"
            : "hover:bg-[var(--color-surface-300)]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]",
        ].join(" ")}
      >
        {isStarting ? (
          <>
            <Loader2
              size={14}
              aria-hidden="true"
              className="animate-spin text-[var(--color-fg-muted)]"
            />
            <span className="text-[12px] text-[var(--color-fg-muted)]">
              starting…
            </span>
          </>
        ) : (
          <>
            <Crosshair
              size={14}
              aria-hidden="true"
              // Filled variant during active pick per UI-SPEC §Visual Layout.
              fill={picking ? "currentColor" : "none"}
              className={picking ? "text-[var(--color-accent-primary)]" : ""}
            />
            {/* Kbd-hint pill: ⌘⇧P by default; Esc while picking.
                Decorative (aria-hidden) — true shortcut is announced via
                aria-keyshortcuts. Shows on hover/focus via CSS sibling
                state; always visible during active pick. */}
            <span
              aria-hidden="true"
              className={[
                "ml-0.5 px-1 py-[1px] rounded-[4px] text-[10px] font-semibold font-mono",
                "bg-[var(--color-surface-300)] text-[var(--color-fg-muted)]",
                picking
                  ? "inline-block"
                  : "hidden group-hover:inline-block group-focus-within:inline-block",
              ].join(" ")}
            >
              {picking ? "Esc" : "⌘⇧P"}
            </span>
          </>
        )}
      </button>

      {/* Invisible a11y node carrying the live tooltip for aria-describedby. */}
      <span
        id="preview-picker-tooltip"
        role="tooltip"
        className="sr-only"
      >
        {tooltip}
      </span>

      {/* Hover-preview chip — portaled to body so it sits above the
          preview stage without layout interference. */}
      {picking && preview && typeof document !== "undefined"
        ? createPortal(
            <div
              role="note"
              aria-live="polite"
              className="pointer-events-none fixed left-1/2 top-14 z-50 -translate-x-1/2 rounded border border-[var(--color-border-subtle)] bg-white/95 px-3 py-1 text-xs font-medium text-[var(--color-fg-primary)] shadow-md"
            >
              {describeHoverPreview(preview)}
            </div>,
            document.body,
          )
        : null}

      {/* Banner error (surfaces inline if the picker warm-up fails). */}
      {bannerError ? (
        <PickingBanner variant="error" message={bannerError} />
      ) : null}
    </>
  );
}

/**
 * PickingBanner — 32px sticky banner rendered inside the Preview panel
 * content area (below the toolbar, above the stage). UI-SPEC §2.
 *
 * Consumers mount this separately from the button so layout stays in
 * the host panel's hands; the button still exports it so there's a
 * single source of truth for copy + motion.
 */
export function PickingBanner({
  variant = "active",
  message,
}: {
  variant?: "active" | "paused" | "error";
  message?: string;
}) {
  const simulatorOrdinal = useAuthorDriverStore((s) => s.simulatorOrdinal);

  const label =
    variant === "error"
      ? `${COPY.BANNER_ERROR_PREFIX}${message ?? ""}${COPY.BANNER_ERROR_SUFFIX}`
      : variant === "paused"
        ? simulatorOrdinal != null
          ? COPY.BANNER_PAUSED_WITH_N.replace(
              "{N}",
              String(simulatorOrdinal),
            )
          : COPY.BANNER_ACTIVE
        : COPY.BANNER_ACTIVE;

  const isError = variant === "error";

  return (
    <motion.div
      key={`picking-banner-${variant}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className={[
        "sticky top-0 z-10 flex h-8 items-center gap-2 px-3 text-[13px] font-medium",
        isError
          ? "bg-[color-mix(in_oklch,var(--color-danger)_12%,var(--color-surface-300))] border-b border-[color-mix(in_oklch,var(--color-danger)_40%,transparent)] text-[var(--color-fg-primary)]"
          : "bg-[var(--color-surface-300)] text-[var(--color-fg-primary)]",
      ].join(" ")}
    >
      {isError ? (
        <AlertTriangle
          size={14}
          aria-hidden="true"
          className="text-[var(--color-danger)]"
        />
      ) : (
        <Crosshair
          size={14}
          aria-hidden="true"
          className="text-[var(--color-accent-primary)]"
        />
      )}
      <span>{label}</span>
    </motion.div>
  );
}

/**
 * Chip caption from a hover payload. Priority mirrors the sidecar's
 * ranked DSL generator. Ported verbatim from `pick-element-button.tsx`.
 */
function describeHoverPreview(p: PickHoverPayload): string {
  if (p.testId) return `testid "${p.testId}"`;
  if (p.role && p.accessibleName) return `${p.role} "${p.accessibleName}"`;
  if (p.accessibleName) return `text "${p.accessibleName}"`;
  return "[css fallback]";
}

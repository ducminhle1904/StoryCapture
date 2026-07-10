/**
 * PreviewPickerButton — author-time element picker in the Preview panel.
 *
 * Click flow: cancel-if-picking, no-op when simulator is running, warn when
 * no streamId, then dispatch `pickElementAuthor`. On Picked, stash in
 * `pendingPick` and show `PickerActionMenu` so the user picks the verb;
 * only then do we build the DSL line, insert/replace, and stamp
 * `.story.targets.json`. On Cancelled, surface a reason-specific toast
 * (silent on user-cancel).
 *
 * Keymap integration: `registerPickTrigger` exposes the onClick as a
 * module-level handler so `codemirror-setup.ts` can dispatch it from
 * `Mod-Shift-p`. Explicit registration is preferred over a global
 * `document.addEventListener`.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Crosshair, Loader2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  type AuthorDriverVariant,
  useAuthorDriverStore,
} from "@/features/editor/authorDriverStore";
import { editorController } from "@/features/editor/controller";
import { PickerActionMenu } from "@/features/editor/PickerActionMenu";
import {
  buildPickerActionLine,
  getPickerActionItems,
  inferDefaultAction,
  type PickerAction,
  type PickerActionOptions,
  parsePickerLine,
  pickedTargetLabel,
} from "@/features/editor/picker-action-dsl";
import {
  isPicked,
  listenPickerHoverPreview,
  type PickHoverPayload,
  type PickPicked,
  pickElementAuthor,
  pickElementCancel,
  pickerStampStepId,
  type TargetRecordDto,
} from "@/ipc/picker";
import { useEditorStore } from "@/state/editor";

/**
 * Locked copy constants — single source of truth for tooltips, toasts,
 * banners, and aria-labels so the strings stay grep-checkable.
 */
const COPY = {
  // Tooltips
  TOOLTIP_IDLE: "Pick element · starts Preview",
  TOOLTIP_LIVE: "Pick element · ⌘⇧P",
  TOOLTIP_PICKING: "Picking — press Esc",
  TOOLTIP_STARTING: "Starting session…",
  TOOLTIP_SIMULATOR_RUNNING: "Simulator running — cancel to pick",
  TOOLTIP_SIMULATOR_PAUSED_WITH_N: "Paused at step {N} — Pick will resume Preview after",
  TOOLTIP_SIMULATOR_PAUSED_NO_N: "Paused — Pick will resume Preview after",
  // aria-label
  ARIA_LABEL: "Pick element from preview (Cmd-Shift-P)",
  ARIA_LABEL_PICKING: "Picking — press Esc to cancel",
  ARIA_LABEL_STARTING: "Starting author session…",
  // Banner
  BANNER_ACTIVE: "PICKING — press Esc to cancel",
  BANNER_PAUSED_WITH_N: "PICKING — press Esc (Preview will stay paused at step {N})",
  BANNER_ERROR_PREFIX: "Couldn't start picker — ",
  BANNER_ERROR_SUFFIX: ". Try again or toggle Preview off and on.",
  // Toasts
  TOAST_PICK_NAVIGATION: "Picking cancelled — page navigated",
  TOAST_PICK_UNSUPPORTED:
    "Picking unavailable on this page (`chrome://`, `about:`, or `view-source:`)",
  TOAST_PICK_WARM_UP_PARTIAL: "Warming context hit an error — picking on whichever page loaded",
  TOAST_PICK_TIMEOUT: "Picker timed out — try again",
  TOAST_DIRTY_WARNING: "Unsaved changes — Pick will use the last saved version. Save first?",
  TOAST_NO_CURSOR: "No cursor position",
  TOAST_NO_STREAM: "Enable Live Preview first — Pick needs an author session",
} as const;

interface PendingPick {
  result: PickPicked;
  cursorLine: number;
  lineText: string;
}

/**
 * Module-level trigger registration so the keymap and the button share
 * a single implementation.
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
        ? COPY.TOOLTIP_SIMULATOR_PAUSED_WITH_N.replace("{N}", String(simulatorOrdinal))
        : COPY.TOOLTIP_SIMULATOR_PAUSED_NO_N;
  }
}

export function PreviewPickerButton() {
  const variant = useAuthorDriverStore((s) => s.variant);
  const streamId = useAuthorDriverStore((s) => s.streamId);
  const simulatorOrdinal = useAuthorDriverStore((s) => s.simulatorOrdinal);
  const setSnapshot = useAuthorDriverStore((s) => s.setSnapshot);

  const [isStarting, setIsStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<PickHoverPayload | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [dragSecondPickInFlight, setDragSecondPickInFlight] = useState(false);

  const isSimulatorRunning = variant === "simulator-running";
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
          .then(() => unlisten?.())
          .catch(() => {});
      }
      setPreview(null);
    };
  }, [picking]);

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

    if (editorController.isDirty()) {
      toast.warning(COPY.TOAST_DIRTY_WARNING, {
        id: "picker-dirty-warning",
        duration: Infinity,
        description:
          "Cmd-S to save, then re-pick — or proceed and the picker uses the on-disk version.",
      });
    }

    const storySrc = useEditorStore.getState().source;

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
        setPendingPick({
          result: r,
          cursorLine,
          lineText: editorController.getCursorLineText() ?? "",
        });
      } else {
        switch (r.reason) {
          case "user-cancel":
            // Silent — no toast on user-cancel.
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
      setBannerError(msg);
      toast.error(`${COPY.BANNER_ERROR_PREFIX}${msg}${COPY.BANNER_ERROR_SUFFIX}`);
      void COPY.TOAST_PICK_WARM_UP_PARTIAL;
    } finally {
      setPicking(false);
      setIsStarting(false);
      setSnapshot({ variant: streamId ? "live-preview" : "idle" });
    }
  };

  onClickRef.current = onClick;

  const collectExtraOptions = async (action: PickerAction): Promise<PickerActionOptions | null> => {
    if (action === "upload") {
      const selected = await openDialog({ multiple: false, directory: false });
      if (!selected || typeof selected !== "string") return null;
      return { path: selected };
    }
    if (action === "drag") {
      if (!streamId || !pendingPick) return null;
      const storySrc = useEditorStore.getState().source;
      setPicking(true);
      setDragSecondPickInFlight(true);
      setSnapshot({ variant: "picking" });
      try {
        const r = await pickElementAuthor({
          streamId,
          storySrc,
          cursorLine: pendingPick.cursorLine,
          timeoutMs: 60_000,
        });
        if (isPicked(r)) return { toLocator: r.locator };
        return null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(msg);
        return null;
      } finally {
        setPicking(false);
        setDragSecondPickInFlight(false);
        setSnapshot({ variant: streamId ? "live-preview" : "idle" });
      }
    }
    return {};
  };

  const onMenuChoose = async (action: PickerAction, options?: PickerActionOptions) => {
    if (!pendingPick) return;
    const captured = pendingPick;
    const { result: r, lineText } = captured;

    // Keep `pendingPick` set during drag's second pick so its cursor line
    // is still readable from `collectExtraOptions`.
    let merged: PickerActionOptions | undefined = options;
    if (action === "upload" || action === "drag") {
      const extra = await collectExtraOptions(action);
      if (!extra) {
        setPendingPick(null);
        return;
      }
      merged = { ...(options ?? {}), ...extra };
    }
    setPendingPick(null);

    const parsed = parsePickerLine(lineText);
    let finalLine: string;
    try {
      finalLine = buildPickerActionLine(action, r.locator, parsed, merged);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
      return;
    }

    const res = parsed.hasTargetShape
      ? editorController.replaceCursorLine(finalLine)
      : editorController.insertAtCursor(`${finalLine}\n`);
    if (!res.ok) {
      toast.error("Editor not ready — focus the editor first");
      return;
    }

    const storyPath = editorController.getStoryPath();
    const successToast = `Added \`${finalLine.trim()}\` · line ${res.lineNumber}`;

    if (action === "drag") {
      toast.success(`${successToast} · selector healing for drag targets is not available yet`);
      return;
    }

    if (!storyPath) {
      toast.success(successToast);
      return;
    }

    try {
      const stamp = await pickerStampStepId({
        storyPath,
        lineOffset: res.lineNumber,
        primary: r.locator as TargetRecordDto,
        fallbacks: r.candidates.map(
          (c) => ({ kind: c.kind, value: c.value, nth: c.nth }) as TargetRecordDto,
        ),
      });
      if (stamp.wasFreshlyStamped) {
        toast.success(successToast);
      } else {
        const stepOrdinal =
          editorController.getStepOrdinalForLine(res.lineNumber) ?? res.lineNumber;
        toast.success(`Updated fallback for step ${stepOrdinal}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
    }
  };

  const onMenuCancel = () => {
    setPendingPick(null);
  };

  const pickResult = pendingPick?.result;
  const lineText = pendingPick?.lineText;
  const menuTargetLabel = useMemo(
    () => (pickResult ? pickedTargetLabel(pickResult) : ""),
    [pickResult],
  );
  const menuDefaultAction = useMemo<PickerAction>(
    () => (lineText !== undefined ? inferDefaultAction(lineText) : "click"),
    [lineText],
  );
  const menuItems = useMemo(() => getPickerActionItems(pickResult?.element), [pickResult?.element]);

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
          "inline-flex items-center gap-1 h-7 px-2.5 rounded-sm",
          "border",
          picking ? "border-(--color-accent-primary)" : "border-transparent",
          "bg-(--color-surface-200) text-(--color-fg-primary) transition-colors",
          disabled
            ? "opacity-60 cursor-not-allowed hover:bg-(--color-surface-200)"
            : "hover:bg-(--color-surface-300)",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        ].join(" ")}
      >
        {isStarting ? (
          <>
            <Loader2
              size={14}
              aria-hidden="true"
              className="animate-spin text-(--color-fg-muted)"
            />
            <span className="text-[12px] text-(--color-fg-muted)">starting…</span>
          </>
        ) : (
          <>
            <Crosshair
              size={14}
              aria-hidden="true"
              // Filled during active pick.
              fill={picking ? "currentColor" : "none"}
              className={picking ? "text-(--color-accent-primary)" : ""}
            />
            {/* Kbd-hint pill: decorative (aria-hidden); true shortcut is
                announced via aria-keyshortcuts. Always visible during pick. */}
            <span
              aria-hidden="true"
              className={[
                "ml-0.5 px-1 py-px rounded-[4px] text-[10px] font-semibold font-mono",
                "bg-(--color-surface-300) text-(--color-fg-muted)",
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
      <span id="preview-picker-tooltip" role="tooltip" className="sr-only">
        {tooltip}
      </span>

      {/* Hover-preview chip — portaled to body so it sits above the
          preview stage without layout interference. */}
      {picking && preview && typeof document !== "undefined"
        ? createPortal(
            <div
              role="note"
              aria-live="polite"
              className="pointer-events-none fixed left-1/2 top-14 z-50 -translate-x-1/2 rounded border border-(--color-border-subtle) bg-white/95 px-3 py-1 text-xs font-medium text-(--color-fg-primary) shadow-md"
            >
              {describeHoverPreview(preview)}
            </div>,
            document.body,
          )
        : null}

      {/* Banner error (surfaces inline if the picker warm-up fails). */}
      {bannerError ? <PickingBanner variant="error" message={bannerError} /> : null}

      {pendingPick && !dragSecondPickInFlight ? (
        <PickerActionMenu
          key={`pick-${pendingPick.cursorLine}-${pendingPick.lineText}`}
          targetLabel={menuTargetLabel}
          defaultAction={menuDefaultAction}
          items={menuItems}
          meta={pendingPick.result.element}
          onChoose={onMenuChoose}
          onCancel={onMenuCancel}
        />
      ) : null}
    </>
  );
}

/**
 * PickingBanner — sticky banner rendered inside the Preview panel
 * content area (below the toolbar, above the stage). Consumers mount it
 * separately from the button so layout stays in the host panel's hands;
 * the button still exports it as the single source of truth for copy.
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
          ? COPY.BANNER_PAUSED_WITH_N.replace("{N}", String(simulatorOrdinal))
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
          ? "bg-[color-mix(in_oklch,var(--color-danger)_12%,var(--color-surface-300))] border-b border-[color-mix(in_oklch,var(--color-danger)_40%,transparent)] text-(--color-fg-primary)"
          : "bg-(--color-surface-300) text-(--color-fg-primary)",
      ].join(" ")}
    >
      {isError ? (
        <AlertTriangle size={14} aria-hidden="true" className="text-danger" />
      ) : (
        <Crosshair size={14} aria-hidden="true" className="text-(--color-accent-primary)" />
      )}
      <span>{label}</span>
    </motion.div>
  );
}

/**
 * Chip caption from a hover payload. Priority mirrors the sidecar's
 * ranked DSL generator.
 */
function describeHoverPreview(p: PickHoverPayload): string {
  if (p.testId) return `testid "${p.testId}"`;
  if (p.role && p.accessibleName) return `${p.role} "${p.accessibleName}"`;
  if (p.accessibleName) return `text "${p.accessibleName}"`;
  return "[css fallback]";
}

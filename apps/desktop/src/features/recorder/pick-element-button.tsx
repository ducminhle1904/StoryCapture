/**
 * PickElementButton — toolbar button + aria-live banner that drives the
 * Playwright sidecar's element picker.
 *
 * Flow:
 *   click → setPicking(true) → portal banner ("PICKING — press Esc to cancel")
 *   → await pickElement({ timeoutMs: 60000 })
 *   → on Picked: editorController.insertAtCursor(r.emitted + "\n")
 *   → on Cancelled: toast for the specific reason
 *   → finally setPicking(false)
 *
 * Esc-on-desktop while picking calls picker_cancel — secondary safety
 * net (the overlay also handles its own Esc).
 *
 * Disabled unless the recorder store reports a status that implies the
 * sidecar session is alive. We treat "recording" as the live-session
 * marker; idle / preflight / completed / failed all imply no driver.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Crosshair } from "lucide-react";
import { toast } from "sonner";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { editorController } from "@/features/editor/controller";
import {
  isPicked,
  listenPickerHoverPreview,
  pickElement,
  pickElementCancel,
  pickerStampStepId,
  type PickHoverPayload,
  type TargetRecordDto,
} from "@/ipc/picker";
import { useRecorderStore } from "@/state/recorder";

export function PickElementButton() {
  const status = useRecorderStore((s) => s.status);
  const [picking, setPicking] = useState(false);
  // live hover preview. Updated by the `picker_hover_preview`
  // Tauri event (forwarded from the sidecar's id-absent JSON-RPC
  // notification). Cleared when picking ends.
  const [preview, setPreview] = useState<PickHoverPayload | null>(null);

  // Sidecar is alive while the recorder is actively running. Paused is
  // also "alive" (driver still around); idle / preflight / stopping /
  // completed / failed all imply no driver.
  const sessionLive = status === "recording" || status === "paused";

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

  // subscribe to hover-preview events while picking.
  // The Rust forwarder emits `picker_hover_preview` at most ~60 Hz
  // (overlay is rAF-throttled); React setState coalesces at render
  // cadence so the chip updates smoothly without extra debouncing.
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
          // Picker ended before listener attached — detach immediately.
          try {
            u();
          } catch {
            /* backend may already have torn down */
          }
        } else {
          unlisten = u;
        }
      })
      .catch(() => {
        /* Tauri event bridge unavailable (tests without shouldMockEvents
         * or desktop backend not running) — non-fatal; chip stays empty. */
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        // unlisten() resolves via IPC; swallow errors (test mocks and
        // post-teardown paths may reject the internal invoke).
        Promise.resolve()
          .then(() => unlisten!())
          .catch(() => {
            /* non-fatal */
          });
      }
      setPreview(null);
    };
  }, [picking]);

  const onClick = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const r = await pickElement({ timeoutMs: 60000 });
      if (isPicked(r)) {
        // Wire contract: the sidecar's `emitted` is a single DSL line WITHOUT
        // a trailing newline. We append "\n" here per CONTEXT.md §Insertion
        // semantics so the next line of the editor is fresh.
        const res = editorController.insertAtCursor(r.emitted + "\n");
        if (res.ok) {
          toast.success(`Inserted: ${r.emitted}`);
          // fire-and-forget: stamp a UUIDv7 on the newly
          // inserted line AND seed the sibling `.story.targets.json`
          // with the pick's primary + fallback locators. Skipped when
          // the editor hasn't been told the on-disk path of the open
          // story (unsaved / in-memory buffers have nowhere to stamp).
          // Failure toasts but never blocks the user — the insert has
          // already landed.
          const storyPath = editorController.getStoryPath();
          if (storyPath) {
            pickerStampStepId({
              storyPath,
              lineOffset: res.lineNumber,
              primary: r.locator as TargetRecordDto,
              fallbacks: r.candidates.map(
                (c) => ({ kind: c.kind, value: c.value }) as TargetRecordDto,
              ),
            }).catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              toast.error(`Stamp failed: ${msg}`);
            });
          }
        } else {
          toast.error("Editor not ready — focus the editor first");
        }
      } else {
        switch (r.reason) {
          case "user-cancel":
            toast("Picking cancelled");
            break;
          case "navigation":
            toast.info("Picking cancelled — page navigated");
            break;
          case "unsupported-url":
            toast.warning("Cannot pick on this page (unsupported URL)");
            break;
          case "timeout":
            toast.info("Picking timed out");
            break;
          default:
            toast(`Picking ended: ${r.reason}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Pick failed: ${msg}`);
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={!sessionLive || picking}
        aria-label="Pick element from browser"
        className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg-primary)] transition-[transform,background-color] duration-150 hover:bg-[var(--color-surface-300)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Crosshair size={13} aria-hidden="true" />
        Pick element
      </button>
      {picking && typeof document !== "undefined"
        ? createPortal(
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-full bg-[var(--color-warning,#d97706)] px-4 py-1.5 text-sm font-medium text-white shadow-lg"
            >
              PICKING — press Esc to cancel
            </div>,
            document.body,
          )
        : null}
      {/* live hover-preview chip. Portal'd below the
         PICKING banner so the two stack without overlap. Uses role="note"
         + aria-live="polite" so screen readers can announce changes
         without stealing focus from the picking banner. */}
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
    </>
  );
}

/**
 * Build the chip caption from a hover payload. Priority matches the
 * sidecar's ranked DSL generator: testid → role+name → text → css
 * fallback sentinel. Kept local because the semantics are UI-only
 * (the ranked DSL itself still comes from the sidecar on click).
 */
function describeHoverPreview(p: PickHoverPayload): string {
  if (p.testId) return `testid "${p.testId}"`;
  if (p.role && p.accessibleName)
    return `${p.role} "${p.accessibleName}"`;
  if (p.accessibleName) return `text "${p.accessibleName}"`;
  return "[css fallback]";
}

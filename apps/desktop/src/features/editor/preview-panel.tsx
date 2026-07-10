/**
 * Preview panel — static preview stage with viewport switcher.
 * Flat docked panel with squared corners; only the viewport frame gets
 * rounded corners (it represents a device screen).
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { Globe, Monitor, Smartphone, Tablet } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useAuthorDriverStore } from "@/features/editor/authorDriverStore";
import { PickingBanner, PreviewPickerButton } from "@/features/editor/PreviewPickerButton";
import { useSelectorValidation } from "@/features/editor/SelectorValidatorOverlay";
import { type PreviewViewport, useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";

const VIEWPORT_SIZES: Record<PreviewViewport, { label: string; w: number; h: number }> = {
  desktop: { label: "Desktop", w: 1280, h: 800 },
  tablet: { label: "Tablet", w: 768, h: 1024 },
  mobile: { label: "Mobile", w: 375, h: 667 },
};

export function PreviewPanel({
  thumbnailPath,
  sceneName,
  sceneMeta,
  statusLabel = "Static stage",
}: {
  thumbnailPath?: string | null;
  sceneName?: string | null;
  sceneMeta?: string | null;
  statusLabel?: string;
}) {
  const viewport = useEditorStore((s) => s.previewViewport);
  const setViewport = useEditorStore((s) => s.setViewport);
  const size = VIEWPORT_SIZES[viewport];

  const runState = useSimulatorStore((s) => s.runState);
  const currentOrd = useSimulatorStore((s) => s.currentFrameOrdinal);
  const frames = useSimulatorStore((s) => s.frames);
  const activeFrame =
    runState !== "idle" && currentOrd != null ? (frames[currentOrd - 1] ?? null) : null;

  // Aggregate validator chip counts for the footer's "2G / 1Y / 0R"
  // summary, sourced from the SelectorValidatorOverlay's store.
  const validationEntries = useSelectorValidation((s) => s.entries);
  const chipCounts = summarizeValidation(validationEntries);

  const isPicking = useAuthorDriverStore((s) => s.variant === "picking");

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--color-surface-100)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
            Preview
          </span>
          <PreviewPickerButton />
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
            {size.w} x {size.h}
          </span>
          <div
            role="radiogroup"
            aria-label="Preview viewport"
            className="flex gap-px rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-300)] p-px"
          >
            <ViewportButton
              icon={<Monitor size={13} aria-hidden="true" />}
              label="Desktop"
              active={viewport === "desktop"}
              onClick={() => setViewport("desktop")}
            />
            <ViewportButton
              icon={<Tablet size={13} aria-hidden="true" />}
              label="Tablet"
              active={viewport === "tablet"}
              onClick={() => setViewport("tablet")}
            />
            <ViewportButton
              icon={<Smartphone size={13} aria-hidden="true" />}
              label="Mobile"
              active={viewport === "mobile"}
              onClick={() => setViewport("mobile")}
            />
          </div>
        </div>
      </header>

      {/* Picking banner — sticky at the top of the content area during
          an active pick. */}
      {isPicking ? <PickingBanner variant="active" /> : null}

      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-surface-200)] p-4">
        <div
          role="img"
          className="relative w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-fg-primary)] shadow-[0_12px_30px_rgba(0,0,0,0.10)]"
          style={{
            aspectRatio: `${size.w} / ${size.h}`,
            maxWidth: "min(100%, 640px)",
            maxHeight: "100%",
          }}
          aria-label={`Preview viewport: ${size.label} (${size.w}x${size.h})`}
        >
          <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em]">
            <span className="rounded-[var(--radius-xs)] border border-white/10 bg-black/50 px-1.5 py-0.5 text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              {size.label}
            </span>
            {sceneName ? (
              <span className="rounded-[var(--radius-xs)] border border-white/10 bg-black/50 px-1.5 py-0.5 text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                {sceneName}
              </span>
            ) : null}
          </div>

          {activeFrame ? (
            <SimulatorFrameView frame={activeFrame} />
          ) : thumbnailPath ? (
            <>
              <img
                src={thumbnailPath}
                alt="Story preview frame"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,10,14,0.08),rgba(7,10,14,0.24))]" />
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-white/40">
              <Globe size={36} aria-hidden="true" />
              <span className="text-[10px] tracking-wide">Preview will render here</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-2 text-[10px] text-[var(--color-fg-muted)]">
        <span className="truncate">{sceneName ?? "Select a scene to inspect its framing"}</span>
        <div className="flex items-center gap-2 font-mono tabular-nums">
          {sceneMeta ? <span>{sceneMeta}</span> : null}
          <span className="text-[var(--color-border-default)]">/</span>
          <span>{statusLabel}</span>
          {chipCounts.total > 0 ? (
            <>
              <span className="text-[var(--color-border-default)]">/</span>
              <span
                role="status"
                aria-label="Selector validator summary"
                data-testid="validator-summary"
                className="flex items-center gap-2"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--color-success)" }}
                />
                <span>{chipCounts.green}</span>
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--color-warning)" }}
                />
                <span>{chipCounts.yellow}</span>
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--color-danger)" }}
                />
                <span>{chipCounts.red}</span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Aggregate the chip-state counts for the preview footer.
 * `total === 0` means the validator hasn't run; the caller hides the chunk.
 */
function summarizeValidation(
  entries: Map<
    number,
    {
      status: { status: string } | null;
    }
  >,
): { green: number; yellow: number; red: number; grey: number; total: number } {
  let green = 0;
  let yellow = 0;
  let red = 0;
  let grey = 0;
  for (const e of entries.values()) {
    if (!e.status) continue;
    switch (e.status.status) {
      case "unique":
        green += 1;
        break;
      case "fuzzy":
        yellow += 1;
        break;
      case "none":
        red += 1;
        break;
      case "no_snapshot":
        grey += 1;
        break;
    }
  }
  return { green, yellow, red, grey, total: green + yellow + red + grey };
}

export function SimulatorFrameView({
  frame,
}: {
  frame: {
    ordinal: number;
    screenshot_path: string | null;
    cursor_xy: [number, number];
    matched_bbox: { x: number; y: number; w: number; h: number } | null;
  };
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const src = frame.screenshot_path ? convertFileSrc(frame.screenshot_path) : null;

  return (
    <div className="relative h-full w-full">
      {src ? (
        <motion.img
          key={frame.ordinal}
          src={src}
          alt={`Simulator frame ${frame.ordinal}`}
          className="h-full w-full object-contain"
          initial={{ opacity: 0.7 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.1 }}
          onLoad={(e) =>
            setNatural({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
        />
      ) : (
        <div className="flex h-full items-center justify-center text-white/40 text-[10px]">
          No screenshot captured
        </div>
      )}
      {frame.matched_bbox && natural && (
        <motion.div
          layoutId="sim-bbox"
          transition={{ type: "spring", stiffness: 180, damping: 24 }}
          aria-hidden="true"
          style={{
            position: "absolute",
            left: `${(frame.matched_bbox.x / natural.w) * 100}%`,
            top: `${(frame.matched_bbox.y / natural.h) * 100}%`,
            width: `${(frame.matched_bbox.w / natural.w) * 100}%`,
            height: `${(frame.matched_bbox.h / natural.h) * 100}%`,
            border: "2px solid var(--color-accent-primary)",
            pointerEvents: "none",
          }}
        />
      )}
      {natural && (
        <motion.div
          layoutId="sim-cursor"
          transition={{ type: "spring", stiffness: 180, damping: 24 }}
          aria-hidden="true"
          style={{
            position: "absolute",
            left: `${(frame.cursor_xy[0] / natural.w) * 100}%`,
            top: `${(frame.cursor_xy[1] / natural.h) * 100}%`,
            width: 10,
            height: 10,
            borderRadius: 5,
            border: "2px solid color-mix(in oklch, var(--color-warning) 70%, transparent)",
            background: "transparent",
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: 4,
              height: 4,
              borderRadius: 2,
              background: "var(--color-warning)",
              transform: "translate(-50%, -50%)",
            }}
          />
        </motion.div>
      )}
    </div>
  );
}

function ViewportButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <label
      aria-label={`Preview as ${label}`}
      className={`inline-flex items-center rounded-[var(--radius-xs)] px-1.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
        active
          ? "bg-[var(--color-surface-100)] text-[var(--color-fg-primary)] shadow-sm"
          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
      }`}
    >
      <input type="radio" checked={active} onChange={onClick} className="sr-only" />
      {icon}
      <span className="sr-only">{label}</span>
    </label>
  );
}

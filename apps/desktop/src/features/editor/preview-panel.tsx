/**
 * Preview panel — Phase 1 shows a static preview stage and viewport switcher.
 * True live-preview browser mirror is deferred to Phase 2.
 *
 * Chrome: flat docked panel with squared corners. Only the viewport frame
 * itself gets rounded corners (it represents a device screen).
 */

import { Globe, Monitor, Tablet, Smartphone } from "lucide-react";

import { useEditorStore, type PreviewViewport } from "@/state/editor";

const VIEWPORT_SIZES: Record<
  PreviewViewport,
  { label: string; w: number; h: number }
> = {
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

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--color-surface-100)]">
      {/* Header — flat, no card chrome */}
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
          Preview
        </span>
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

      {/* Preview stage — the viewport frame gets rounded corners (device screen) */}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-surface-200)] p-4">
        <div
          className="relative w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-fg-primary)] shadow-[0_12px_30px_rgba(0,0,0,0.10)]"
          style={{
            aspectRatio: `${size.w} / ${size.h}`,
            maxWidth: "min(100%, 640px)",
            maxHeight: "100%",
          }}
          aria-label={`Preview viewport: ${size.label} (${size.w}x${size.h})`}
        >
          {/* Viewport info overlays */}
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

          {thumbnailPath ? (
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
              <span className="text-[10px] tracking-wide">
                Preview will render here
              </span>
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
        </div>
      </div>
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
    <button
      role="radio"
      aria-checked={active}
      aria-label={`Preview as ${label}`}
      onClick={onClick}
      className={`inline-flex items-center rounded-[var(--radius-xs)] px-1.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
        active
          ? "bg-[var(--color-surface-100)] text-[var(--color-fg-primary)] shadow-sm"
          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
      }`}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}

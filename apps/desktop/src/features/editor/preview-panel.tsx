/**
 * Preview panel — Phase 1 shows a static preview stage and viewport switcher.
 * True live-preview browser mirror is deferred to Phase 2.
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
}: {
  thumbnailPath?: string | null;
}) {
  const viewport = useEditorStore((s) => s.previewViewport);
  const setViewport = useEditorStore((s) => s.setViewport);
  const size = VIEWPORT_SIZES[viewport];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] shadow-[var(--shadow-card)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2">
        <span className="text-xs font-medium text-[var(--color-fg-muted)]">
          Preview
        </span>
        <div
          role="radiogroup"
          aria-label="Preview viewport"
          className="flex gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] p-0.5"
        >
          <ViewportButton
            icon={<Monitor size={14} aria-hidden="true" />}
            label="Desktop"
            active={viewport === "desktop"}
            onClick={() => setViewport("desktop")}
          />
          <ViewportButton
            icon={<Tablet size={14} aria-hidden="true" />}
            label="Tablet"
            active={viewport === "tablet"}
            onClick={() => setViewport("tablet")}
          />
          <ViewportButton
            icon={<Smartphone size={14} aria-hidden="true" />}
            label="Mobile"
            active={viewport === "mobile"}
            onClick={() => setViewport("mobile")}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-surface-200)] p-6">
        <div
          className="relative w-full overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-fg-primary)] shadow-[var(--shadow-card)]"
          style={{
            aspectRatio: `${size.w} / ${size.h}`,
            maxWidth: "min(100%, 760px)",
            maxHeight: "100%",
          }}
          aria-label={`Preview viewport: ${size.label} (${size.w}x${size.h})`}
        >
          <div className="absolute left-4 top-4 z-10 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-primary)]/72">
            <span className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-500)] px-2 py-1">
              {size.label}
            </span>
            <span className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-500)] px-2 py-1">
              {size.w} × {size.h}
            </span>
          </div>
          <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-primary)]/72">
            <span className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-500)] px-2 py-1">
              00:04:12
            </span>
            <span className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-500)] px-2 py-1">
              00:12:30
            </span>
          </div>

          {thumbnailPath ? (
            <>
              <img
                src={thumbnailPath}
                alt="Story preview frame"
                className="h-full w-full object-cover opacity-92"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,10,14,0.12),rgba(7,10,14,0.34))]" />
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-[var(--color-fg-muted)]">
              <Globe size={48} aria-hidden="true" />
              <span className="text-xs">
                {size.label} · {size.w}×{size.h}
              </span>
            </div>
          )}
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
      className={`inline-flex items-center rounded-[var(--radius-sm)] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
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

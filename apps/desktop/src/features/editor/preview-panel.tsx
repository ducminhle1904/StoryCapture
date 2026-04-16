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
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(21,26,34,0.95),rgba(15,18,25,0.96))] shadow-[0_24px_90px_rgba(0,0,0,0.24)]">
      <header className="flex items-start justify-between gap-4 border-b border-white/6 px-5 py-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
            Preview stage
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
            Static frame for the current viewport. Live browser mirroring arrives in Phase 2.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Preview viewport"
          className="flex gap-1 rounded-full border border-white/8 bg-black/12 p-1"
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

      <div className="flex min-h-0 flex-1 items-center justify-center bg-[linear-gradient(180deg,#0d1117_0%,#0b0f14_100%)] p-6">
        <div
          className="relative w-full overflow-hidden rounded-[22px] border border-white/8 bg-black shadow-[0_24px_100px_rgba(0,0,0,0.38)]"
          style={{
            aspectRatio: `${size.w} / ${size.h}`,
            maxWidth: "min(100%, 760px)",
            maxHeight: "100%",
          }}
          aria-label={`Preview viewport: ${size.label} (${size.w}x${size.h})`}
        >
          <div className="absolute left-4 top-4 z-10 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/72">
            <span className="rounded-full border border-white/12 bg-black/32 px-2 py-1">
              {size.label}
            </span>
            <span className="rounded-full border border-white/12 bg-black/32 px-2 py-1">
              {size.w} × {size.h}
            </span>
          </div>
          <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/72">
            <span className="rounded-full border border-white/12 bg-black/32 px-2 py-1">
              00:04:12
            </span>
            <span className="rounded-full border border-white/12 bg-black/32 px-2 py-1">
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
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
        active
          ? "bg-[var(--color-accent-primary)] text-white"
          : "text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
      }`}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}

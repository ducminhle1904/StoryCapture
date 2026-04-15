/**
 * Preview panel — Phase 1 shows a static placeholder + viewport switcher
 * (UI-03). True live-preview browser mirror is deferred to Phase 2.
 */

import { Globe, Monitor, Tablet, Smartphone, Info } from "lucide-react";

import { useEditorStore, type PreviewViewport } from "@/state/editor";

const VIEWPORT_SIZES: Record<PreviewViewport, { label: string; w: number; h: number }> = {
  desktop: { label: "Desktop", w: 1280, h: 800 },
  tablet: { label: "Tablet", w: 768, h: 1024 },
  mobile: { label: "Mobile", w: 375, h: 667 },
};

export function PreviewPanel({ thumbnailPath }: { thumbnailPath?: string | null }) {
  const viewport = useEditorStore((s) => s.previewViewport);
  const setViewport = useEditorStore((s) => s.setViewport);
  const size = VIEWPORT_SIZES[viewport];

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-bg-surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-fg-secondary)]">
          <Info size={12} aria-hidden="true" />
          Preview is a static snapshot in Phase 1; live preview arrives in Phase 2.
        </div>
        <div role="radiogroup" aria-label="Preview viewport" className="flex gap-1">
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
      <div className="flex flex-1 items-center justify-center overflow-auto p-6">
        <div
          className="relative rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] grid place-items-center shadow-xl"
          style={{
            aspectRatio: `${size.w} / ${size.h}`,
            width: "100%",
            maxWidth: "min(100%, 720px)",
            maxHeight: "100%",
          }}
          aria-label={`Preview viewport: ${size.label} (${size.w}x${size.h})`}
        >
          {thumbnailPath ? (
            <img
              src={thumbnailPath}
              alt="Project thumbnail"
              className="max-h-full max-w-full object-contain rounded-md"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-[var(--color-fg-muted)]">
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
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
        active
          ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg-primary)]"
          : "text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
      }`}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}

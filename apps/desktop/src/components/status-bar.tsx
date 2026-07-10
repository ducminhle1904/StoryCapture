import { UploadProgress } from "@/components/upload-progress";

/**
 * Application status bar (28px, full width, bottom of window).
 *
 * Three slots:
 *   - Left: upload progress
 *   - Center: sync status (placeholder for now)
 *   - Right: token counter (placeholder — requires session context)
 */
export function StatusBar() {
  return (
    <footer className="flex h-7 shrink-0 items-center border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 text-[11px] text-[var(--color-fg-muted)]">
      {/* Left slot — upload progress */}
      <div className="flex min-w-0 flex-1 items-center">
        <UploadProgress />
      </div>

      {/* Center slot — sync status */}
      <div className="flex items-center gap-1.5 px-4">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
        <span>Synced</span>
      </div>

      {/* Right slot — token counter placeholder */}
      <div className="flex min-w-0 flex-1 items-center justify-end font-mono tabular-nums">
        <span>$0.00</span>
      </div>
    </footer>
  );
}

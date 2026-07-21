/**
 * Upload progress widget for the desktop status bar area.
 *
 * Shows progress bar during upload, success link on completion, error
 * message + retry on failure (no auto-retry), and a cancel button.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { useUploadStore } from "@/stores/upload-store";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "thumbnail":
      return "Generating thumbnail...";
    case "uploading":
      return "Uploading to Web...";
    case "completing":
      return "Finalizing upload...";
    default:
      return "Processing...";
  }
}

export function UploadProgress() {
  const { status, progress, videoSlug, error, cancelUpload, reset } = useUploadStore();

  if (status === "idle") return null;

  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-card)] px-3 py-2 text-sm text-[var(--color-text-primary)]">
      {status === "uploading" && progress && (
        <>
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
              <span>{phaseLabel(progress.phase)}</span>
              {progress.totalParts > 0 && (
                <span>
                  {progress.partNumber}/{progress.totalParts} parts
                </span>
              )}
            </div>

            {/* Progress bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-background-surface)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300"
                style={{
                  width: `${progress.totalBytes > 0 ? (progress.bytesUploaded / progress.totalBytes) * 100 : 0}%`,
                }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-[var(--color-text-disabled)]">
              <span>
                {formatBytes(progress.bytesUploaded)} / {formatBytes(progress.totalBytes)}
              </span>
              <span>
                {progress.totalBytes > 0
                  ? Math.round((progress.bytesUploaded / progress.totalBytes) * 100)
                  : 0}
                %
              </span>
            </div>
          </div>

          <AstryxButton variant="ghost" size="sm" onClick={cancelUpload} label="Cancel upload">
            Cancel
          </AstryxButton>
        </>
      )}

      {status === "uploading" && !progress && (
        <span className="text-[var(--color-text-secondary)]">Preparing upload...</span>
      )}

      {status === "complete" && videoSlug && (
        <div className="flex flex-1 items-center justify-between">
          <span className="text-[var(--color-success)]">Uploaded!</span>
          <AstryxButton
            variant="ghost"
            size="sm"
            href={`https://storycapture.app/watch/${videoSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            label={`View upload ${videoSlug}`}
          >
            View at storycapture.app/watch/{videoSlug}
          </AstryxButton>
          <AstryxButton variant="ghost" size="sm" onClick={reset} label="Dismiss upload status">
            Dismiss
          </AstryxButton>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-1 items-center justify-between">
          <span className="text-[var(--color-error)]">Upload failed: {error}</span>
          <AstryxButton variant="ghost" size="sm" onClick={reset} label="Dismiss upload error">
            Dismiss
          </AstryxButton>
        </div>
      )}
    </div>
  );
}

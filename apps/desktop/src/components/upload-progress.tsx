/**
 * Upload progress widget for the desktop status bar area.
 *
 * Shows:
 * - Progress bar + percentage during upload
 * - "Uploaded! View at storycapture.app/watch/{slug}" on completion
 * - "Upload failed. Retry?" on error (D-01: no auto-retry)
 * - Cancel button during upload
 */

import { useUploadStore } from "@/stores/upload-store";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const { status, progress, videoSlug, error, cancelUpload, reset } =
    useUploadStore();

  if (status === "idle") return null;

  return (
    <div className="flex items-center gap-3 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm">
      {status === "uploading" && progress && (
        <>
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>{phaseLabel(progress.phase)}</span>
              {progress.totalParts > 0 && (
                <span>
                  {progress.partNumber}/{progress.totalParts} parts
                </span>
              )}
            </div>

            {/* Progress bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-700">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{
                  width: `${progress.totalBytes > 0 ? (progress.bytesUploaded / progress.totalBytes) * 100 : 0}%`,
                }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-neutral-500">
              <span>
                {formatBytes(progress.bytesUploaded)} /{" "}
                {formatBytes(progress.totalBytes)}
              </span>
              <span>
                {progress.totalBytes > 0
                  ? Math.round(
                      (progress.bytesUploaded / progress.totalBytes) * 100,
                    )
                  : 0}
                %
              </span>
            </div>
          </div>

          <button
            onClick={cancelUpload}
            className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Cancel upload"
          >
            Cancel
          </button>
        </>
      )}

      {status === "uploading" && !progress && (
        <span className="text-neutral-400">Preparing upload...</span>
      )}

      {status === "complete" && videoSlug && (
        <div className="flex flex-1 items-center justify-between">
          <span className="text-green-400">Uploaded!</span>
          <a
            href={`https://storycapture.app/watch/${videoSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 underline hover:text-blue-300"
          >
            View at storycapture.app/watch/{videoSlug}
          </a>
          <button
            onClick={reset}
            className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-1 items-center justify-between">
          <span className="text-red-400">Upload failed: {error}</span>
          <button
            onClick={reset}
            className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

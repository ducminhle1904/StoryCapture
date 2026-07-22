/**
 * Export-complete toast with "Upload to Web" button.
 *
 * Primary user-facing upload trigger; appears after a successful export.
 * Disabled if no web account is connected.
 */

import type { RecordingV3Mode } from "@storycapture/shared-types/recording-v3";
import { useUploadStore } from "@/stores/upload-store";
import { useWebAccountStore } from "@/stores/web-account-store";

interface ExportCompleteToastProps {
  /** Absolute path to the exported video file. */
  filePath: string;
  /** Project name for the upload metadata. */
  projectName: string;
  /** Optional DSL story source text. */
  storySource?: string;
  /** Optional scene boundaries for chapter navigation. */
  sceneBoundaries?: Array<{
    sceneIndex: number;
    label: string;
    startTimeSec: number;
  }>;
  recordingMode?: RecordingV3Mode | null;
  /** Callback when the toast is dismissed. */
  onDismiss?: () => void;
}

export function ExportCompleteToast({
  filePath,
  projectName,
  storySource,
  sceneBoundaries,
  recordingMode = null,
  onDismiss,
}: ExportCompleteToastProps) {
  const { status: uploadStatus, startUpload } = useUploadStore();
  const { account } = useWebAccountStore();

  const isConnected = account !== null;
  const isUploading = uploadStatus === "uploading";
  const uploadBlocked = recordingMode === "strict_local";

  const handleUpload = () => {
    if (!isConnected || isUploading || uploadBlocked) return;
    startUpload(filePath, projectName, undefined, storySource, sceneBoundaries, recordingMode);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-lg">
      <div className="flex items-center gap-2">
        <span className="text-green-400">Export complete</span>
      </div>

      <p className="text-sm text-neutral-400">
        Video saved to{" "}
        <span className="font-mono text-xs text-neutral-300">
          {filePath.split("/").pop() ?? filePath}
        </span>
      </p>

      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            onClick={handleUpload}
            disabled={!isConnected || isUploading || uploadBlocked}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-[var(--color-fg-primary)] transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              uploadBlocked
                ? "Strict Local exports are not release-certified and cannot be uploaded or shared"
                : !isConnected
                ? "Connect a web account in Settings > Accounts"
                : isUploading
                  ? "Upload in progress..."
                  : "Upload this video to storycapture.app"
            }
          >
            {isUploading ? "Uploading..." : "Upload to Web"}
          </button>
        </div>

        {!isConnected && (
          <span className="text-xs text-neutral-500">
            Connect a web account in Settings &gt; Accounts
          </span>
        )}

        {uploadBlocked ? (
          <span className="text-xs text-amber-400">
            Strict Local — runtime-verified; upload and sharing are disabled
          </span>
        ) : null}

        {onDismiss && (
          <button
            onClick={onDismiss}
            className="ml-auto rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

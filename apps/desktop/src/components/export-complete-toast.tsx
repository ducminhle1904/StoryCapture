/**
 * Export-complete toast with "Upload to Web" button.
 *
 * Primary user-facing upload trigger; appears after a successful export.
 * Disabled if no web account is connected.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
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
  /** Callback when the toast is dismissed. */
  onDismiss?: () => void;
}

export function ExportCompleteToast({
  filePath,
  projectName,
  storySource,
  sceneBoundaries,
  onDismiss,
}: ExportCompleteToastProps) {
  const { status: uploadStatus, startUpload } = useUploadStore();
  const { account } = useWebAccountStore();

  const isConnected = account !== null;
  const isUploading = uploadStatus === "uploading";

  const handleUpload = () => {
    if (!isConnected || isUploading) return;
    startUpload(filePath, projectName, undefined, storySource, sceneBoundaries);
  };

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-card)] p-4 shadow-[var(--shadow-med)]">
      <div className="flex items-center gap-2">
        <span className="text-[var(--color-success)]">Export complete</span>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Video saved to{" "}
        <span className="font-mono text-xs text-[var(--color-text-primary)]">
          {filePath.split("/").pop() ?? filePath}
        </span>
      </p>

      <div className="flex items-center gap-2">
        <div className="relative">
          <AstryxButton
            variant="primary"
            onClick={handleUpload}
            isDisabled={!isConnected || isUploading}
            tooltip={
              !isConnected
                ? "Connect a web account in Settings > Accounts"
                : isUploading
                  ? "Upload in progress..."
                  : "Upload this video to storycapture.app"
            }
            label="Upload to Web"
          >
            {isUploading ? "Uploading..." : "Upload to Web"}
          </AstryxButton>
        </div>

        {!isConnected && (
          <span className="text-xs text-[var(--color-text-disabled)]">
            Connect a web account in Settings &gt; Accounts
          </span>
        )}

        {onDismiss && (
          <AstryxButton
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            label="Dismiss export notification"
            className="ml-auto"
          >
            Dismiss
          </AstryxButton>
        )}
      </div>
    </div>
  );
}

import { convertFileSrc } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import { motion } from "motion/react";

import { PreviewPlayer } from "@/features/post-production/preview/preview-player";
import type { RecordingActions } from "@/ipc/actions";
import { useProjectRecordings } from "@/ipc/projects";
import type {
  CaptureRect,
  RecordingStepTimingSidecar,
  RecordingTrajectory,
} from "@/ipc/trajectory";

export type PreviewSurfaceProps =
  | {
      mode: "post-production";
      storyId: string;
      videoSrc?: string;
      width?: number;
      height?: number;
      actions?: RecordingActions | null;
      trajectory?: RecordingTrajectory | null;
      stepTiming?: RecordingStepTimingSidecar | null;
      captureRect?: CaptureRect | null;
    }
  | {
      mode: "recording";
      projectId: string;
    };

export function PreviewSurface(props: PreviewSurfaceProps) {
  if (props.mode === "post-production") {
    return (
      <PreviewPlayer
        storyId={props.storyId}
        videoSrc={props.videoSrc}
        outputMode="composited-canvas"
        width={props.width}
        height={props.height}
        actions={props.actions}
        trajectory={props.trajectory}
        stepTiming={props.stepTiming}
        captureRect={props.captureRect}
      />
    );
  }
  return <RecordingPreview projectId={props.projectId} />;
}

function RecordingPreview({ projectId }: { projectId: string }) {
  const recordingsQuery = useProjectRecordings(projectId);
  const latest = recordingsQuery.data?.[0] ?? null;

  if (latest) {
    return (
      <div className="flex h-full w-full flex-col bg-[var(--color-background-surface)] text-[var(--color-text-primary)]">
        <div className="flex flex-1 items-center justify-center overflow-hidden p-5">
          {/* biome-ignore lint/a11y/useMediaCaption: user-captured screen recording; no caption track exists in source */}
          <video
            src={convertFileSrc(latest.path)}
            controls
            preload="metadata"
            className="h-full w-full max-w-3xl rounded-[var(--radius-page)] border border-[var(--color-border)] bg-black"
            data-recording-present="true"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-background-surface)] text-[var(--color-text-primary)]">
      <div className="flex flex-1 items-center justify-center overflow-hidden p-5">
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="flex h-full w-full max-w-3xl items-center justify-center rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--story-native-chrome)]"
          data-recording-present="false"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--color-background-surface)]">
              <Film size={20} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
            </div>
            <div className="text-[13px] font-medium text-[var(--color-text-secondary)]">
              No recording yet
            </div>
            <div className="max-w-sm text-[12px] leading-5 text-[var(--color-text-disabled)]">
              Record a story to see the preview.
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

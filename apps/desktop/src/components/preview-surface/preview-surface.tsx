import { useQuery } from "@tanstack/react-query";
import { Film } from "lucide-react";
import { motion } from "motion/react";

import { PreviewPlayer } from "@/features/post-production/preview/preview-player";
import { fetchProjectFolder } from "@/ipc/projects";

export type PreviewSurfaceProps =
  | {
      mode: "composited";
      storyId: string;
      videoSrc?: string;
      width?: number;
      height?: number;
    }
  | {
      mode: "recording";
      projectId: string;
    };

export function PreviewSurface(props: PreviewSurfaceProps) {
  if (props.mode === "composited") {
    return (
      <PreviewPlayer
        storyId={props.storyId}
        videoSrc={props.videoSrc}
        width={props.width}
        height={props.height}
      />
    );
  }
  return <RecordingPreview projectId={props.projectId} />;
}

function RecordingPreview({ projectId }: { projectId: string }) {
  const folderQuery = useQuery({
    queryKey: ["projects", projectId, "folder"],
    queryFn: () => fetchProjectFolder(projectId),
  });

  const sessionCount = folderQuery.data?.session_count ?? 0;
  const hasRecording = sessionCount > 0;

  const headline = hasRecording
    ? "Recording available"
    : "No recording yet";
  const body = hasRecording
    ? "Scrubbable preview coming soon."
    : "Record a story to see the preview.";

  return (
    <div className="flex h-full w-full flex-col bg-[var(--sc-surface)] text-[var(--sc-text)]">
      <div className="flex flex-1 items-center justify-center overflow-hidden p-5">
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="flex h-full w-full max-w-3xl items-center justify-center rounded-[var(--sc-r-2xl)] border border-[var(--sc-border)] bg-[var(--sc-chrome)]"
          data-recording-present={hasRecording ? "true" : "false"}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-[var(--sc-r-2xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]">
              <Film size={20} className="text-[var(--sc-text-3)]" aria-hidden="true" />
            </div>
            <div className="text-[13px] font-medium text-[var(--sc-text-2)]">
              {headline}
            </div>
            <div className="max-w-sm text-[12px] leading-5 text-[var(--sc-text-4)]">
              {body}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

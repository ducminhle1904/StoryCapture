/**
 * Post-Production route (Plan 02-12b).
 *
 * Thin wrapper that pulls `storyId` from the URL and hands it to the
 * editor shell. Real source-video resolution will flow from a future
 * `project_get_recording_path` IPC; for now the shell falls back to a
 * poster when videoSrc is undefined.
 */

import { useParams } from "react-router-dom";

import { EditorShell } from "@/features/post-production/editor-shell";

export default function PostProductionRoute() {
  const { storyId } = useParams<{ storyId: string }>();
  if (!storyId) {
    return (
      <div className="p-6 text-sm text-red-400" role="alert">
        Missing storyId in URL.
      </div>
    );
  }
  return <EditorShell storyId={storyId} />;
}

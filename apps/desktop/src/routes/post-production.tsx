/** Route wrapper that passes `storyId` from the URL into `EditorShell`. */

import { useParams } from "react-router-dom";

import { EditorShell } from "@/features/post-production/editor-shell";

export default function PostProductionRoute() {
  const { storyId } = useParams<{ storyId: string }>();
  if (!storyId) {
    return (
      <div className="sc-window-chrome h-full p-6 text-sm text-red-400" role="alert">
        Missing storyId in URL.
      </div>
    );
  }
  return <EditorShell storyId={storyId} />;
}

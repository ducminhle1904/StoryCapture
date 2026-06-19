import type { CaptureTarget } from "@/ipc/capture";

import type { BrowserViewportSize } from "./recording-viewport";

export type AuthorPreviewRecordingTarget = Extract<CaptureTarget, { kind: "author_preview" }>;

export interface AuthorPreviewRecordingPlan {
  target: AuthorPreviewRecordingTarget;
  width: number;
  height: number;
  frameCrop: null;
}

export function authorPreviewRecordingPlan(
  streamId: string,
  viewport: BrowserViewportSize,
): AuthorPreviewRecordingPlan {
  return {
    target: {
      kind: "author_preview",
      stream_id: streamId,
    },
    width: viewport.width,
    height: viewport.height,
    frameCrop: null,
  };
}

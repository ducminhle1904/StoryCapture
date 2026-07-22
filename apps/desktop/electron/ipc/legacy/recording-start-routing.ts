import type { StartRecordingArgs } from "@storycapture/shared-types";
import type { WebContents } from "electron";

export interface RecordingStartRouteDependencies {
  authorPreviewUrl: (streamId: string) => string;
  startStrictBrowser: (
    args: StartRecordingArgs,
    onEvent: unknown,
    sender: WebContents,
    url: string,
  ) => Promise<{ id: string }>;
}

export async function routeSpecializedRecordingStart(
  args: StartRecordingArgs,
  onEvent: unknown,
  sender: WebContents,
  dependencies: RecordingStartRouteDependencies,
): Promise<{ handled: false } | { handled: true; result: { id: string } }> {
  if (args.delivery_policy !== "strict" && args.delivery_policy !== "development") {
    return { handled: false };
  }
  const url =
    args.target.kind === "author_preview"
      ? dependencies.authorPreviewUrl(args.target.stream_id)
      : "";
  return {
    handled: true,
    result: await dependencies.startStrictBrowser(args, onEvent, sender, url),
  };
}

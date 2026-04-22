import { invoke } from "@tauri-apps/api/core";

export interface PreviewFramePayload {
  data: string;
  width: number;
  height: number;
  timestamp: number;
  streamId?: string | null;
}

export async function startPreviewStream(): Promise<void> {
  await invoke("start_preview_stream");
}

export async function stopPreviewStream(): Promise<void> {
  await invoke("stop_preview_stream");
}

export async function startAuthorPreview(params: {
  initialUrl: string | null;
  viewportWidth: number;
  viewportHeight: number;
}): Promise<string> {
  return await invoke<string>("start_author_preview", {
    initialUrl: params.initialUrl,
    viewportWidth: params.viewportWidth,
    viewportHeight: params.viewportHeight,
  });
}

export async function stopAuthorPreview(streamId: string): Promise<void> {
  await invoke("stop_author_preview", { streamId });
}

export async function pauseAuthorPreview(streamId: string): Promise<void> {
  await invoke("pause_author_preview", { streamId });
}

export async function resumeAuthorPreview(streamId: string): Promise<void> {
  await invoke("resume_author_preview", { streamId });
}

export async function setAuthorPreviewViewport(
  streamId: string,
  width: number,
  height: number,
): Promise<void> {
  await invoke("set_author_preview_viewport", {
    streamId,
    args: { width, height },
  });
}

export async function setAuthorPreviewUrl(streamId: string, url: string): Promise<void> {
  await invoke("set_author_preview_url", { streamId, url });
}

export async function attachAuthorDriver(streamId: string): Promise<void> {
  await invoke("attach_author_driver", { streamId });
}

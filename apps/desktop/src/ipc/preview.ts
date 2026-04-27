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

export interface AuthorPreviewNavPayload {
  streamId: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export async function authorPreviewBack(streamId: string): Promise<void> {
  await invoke("author_preview_back", { streamId });
}

export async function authorPreviewForward(streamId: string): Promise<void> {
  await invoke("author_preview_forward", { streamId });
}

export async function authorPreviewReload(streamId: string): Promise<void> {
  await invoke("author_preview_reload", { streamId });
}

export async function attachAuthorDriver(streamId: string): Promise<void> {
  await invoke("attach_author_driver", { streamId });
}

export type AuthorMouseButton = "left" | "right" | "middle";

export interface AuthorKeyModifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export type AuthorInputEvent =
  | { type: "mousemove"; x: number; y: number }
  | { type: "click"; x: number; y: number; button: AuthorMouseButton }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | {
      type: "keydown";
      key: string;
      code: string;
      modifiers: AuthorKeyModifiers;
      repeat: boolean;
    }
  | {
      type: "keyup";
      key: string;
      code: string;
      modifiers: AuthorKeyModifiers;
    }
  | { type: "text"; text: string };

/**
 * Forward a pointer/wheel event from the LivePreview canvas into the
 * headless author browser. Coordinates must be in PAGE viewport space —
 * the LivePreview component handles the canvas px → page px transform.
 */
export async function authorDispatchInput(
  streamId: string,
  event: AuthorInputEvent,
): Promise<void> {
  await invoke("author_dispatch_input", { streamId, event });
}

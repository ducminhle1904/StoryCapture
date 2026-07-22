/**
 * Zustand store for upload state management.
 *
 * Listens to Tauri Channel<T> progress events from the upload_video command.
 * No auto-retry — user manually triggers upload.
 */

import type { RecordingV3Mode } from "@storycapture/shared-types/recording-v3";
import { invoke, Channel } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface UploadProgress {
  phase: string; // "thumbnail" | "uploading" | "completing"
  partNumber: number;
  totalParts: number;
  bytesUploaded: number;
  totalBytes: number;
}

export interface UploadStore {
  status: "idle" | "uploading" | "complete" | "error";
  progress: UploadProgress | null;
  videoSlug: string | null;
  error: string | null;
  // Actions
  startUpload: (
    filePath: string,
    projectName: string,
    workspaceId?: string,
    storySource?: string,
    sceneBoundaries?: unknown[],
    recordingMode?: RecordingV3Mode | null,
  ) => Promise<void>;
  cancelUpload: () => Promise<void>;
  reset: () => void;
}

export const useUploadStore = create<UploadStore>((set) => ({
  status: "idle",
  progress: null,
  videoSlug: null,
  error: null,

  startUpload: async (
    filePath: string,
    projectName: string,
    workspaceId?: string,
    storySource?: string,
    sceneBoundaries?: unknown[],
    recordingMode?: RecordingV3Mode | null,
  ) => {
    set({ status: "uploading", progress: null, videoSlug: null, error: null });

    try {
      // Create a Channel for progress events (same pattern as render progress)
      const onProgress = new Channel<UploadProgress>();
      onProgress.onmessage = (event: UploadProgress) => {
        set({ progress: event });
      };

      const result = await invoke<{
        videoId: string;
        slug: string;
        status: string;
      }>("upload_video", {
        videoPath: filePath,
        projectName,
        workspaceId: workspaceId ?? null,
        storySource: storySource ?? null,
        sceneBoundaries: sceneBoundaries
          ? JSON.stringify(sceneBoundaries)
          : null,
        onProgress,
        recordingMode: recordingMode ?? null,
      });

      set({
        status: "complete",
        videoSlug: result.slug,
        progress: null,
        error: null,
      });
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Upload failed. Please try again.";
      set({ status: "error", error: message, progress: null });
    }
  },

  cancelUpload: async () => {
    try {
      await invoke("cancel_upload");
      set({ status: "idle", progress: null, error: null });
    } catch {
      // Cancel may fail if no upload in progress — that's fine
    }
  },

  reset: () => {
    set({ status: "idle", progress: null, videoSlug: null, error: null });
  },
}));

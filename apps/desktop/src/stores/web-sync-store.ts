/**
 * Web sync Zustand store — manages desktop-to-web sync state.
 *
 * Wraps the Tauri sync commands: sync_project_metadata, flush_sync_queue,
 * get_sync_status, update_recording_status.
 *
 * On app startup: calls flush_sync_queue and get_sync_status.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

interface SyncStatus {
  connected: boolean;
  pendingCount: number;
  lastSync: string | null;
}

interface SyncResult {
  synced: boolean;
  lastSyncedAt: string;
}

interface FlushResult {
  flushed: number;
  failed: number;
  remaining: number;
}

interface WebSyncState {
  /** Whether the web account is connected and reachable */
  connected: boolean;
  /** Number of pending offline queue items */
  pendingCount: number;
  /** ISO timestamp of last successful sync */
  lastSync: string | null;
  /** Current recording status being pushed */
  recordingStatus: string;
  /** Whether a sync operation is in progress */
  syncing: boolean;
  /** Last error message */
  error: string | null;
}

interface WebSyncActions {
  /** Initialize sync state on app startup */
  initialize: () => Promise<void>;
  /** Sync a project's metadata to the web companion */
  syncProject: (
    desktopId: string,
    workspaceId: string,
    projectName: string,
    storySource?: string,
  ) => Promise<void>;
  /** Check current sync status */
  checkStatus: () => Promise<void>;
  /** Flush the offline queue */
  flushQueue: () => Promise<void>;
  /** Update recording status (fire-and-forget) */
  updateRecordingStatus: (
    desktopId: string,
    workspaceId: string,
    status: string,
  ) => Promise<void>;
}

export const useWebSyncStore = create<WebSyncState & WebSyncActions>(
  (set) => ({
    // State
    connected: false,
    pendingCount: 0,
    lastSync: null,
    recordingStatus: "idle",
    syncing: false,
    error: null,

    // Actions
    initialize: async () => {
      try {
        // Flush any pending items first
        await invoke<FlushResult>("flush_sync_queue").catch(() => {
          // May fail if not connected — that's OK
        });

        // Then check status
        const status = await invoke<SyncStatus>("get_sync_status");
        set({
          connected: status.connected,
          pendingCount: status.pendingCount,
          lastSync: status.lastSync,
          error: null,
        });
      } catch (err) {
        // Not connected or no account — silently degrade
        set({ connected: false, error: null });
      }
    },

    syncProject: async (desktopId, workspaceId, projectName, storySource) => {
      set({ syncing: true, error: null });
      try {
        const result = await invoke<SyncResult>("sync_project_metadata", {
          desktopId,
          workspaceId,
          projectName,
          storySource: storySource ?? null,
        });
        set({
          syncing: false,
          lastSync: result.lastSyncedAt,
          connected: true,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        set({
          syncing: false,
          error: message,
        });
        // Re-check pending count (item may have been queued)
        try {
          const status = await invoke<SyncStatus>("get_sync_status");
          set({ pendingCount: status.pendingCount });
        } catch {
          // Ignore
        }
      }
    },

    checkStatus: async () => {
      try {
        const status = await invoke<SyncStatus>("get_sync_status");
        set({
          connected: status.connected,
          pendingCount: status.pendingCount,
          lastSync: status.lastSync,
        });
      } catch {
        set({ connected: false });
      }
    },

    flushQueue: async () => {
      try {
        const result = await invoke<FlushResult>("flush_sync_queue");
        set({ pendingCount: result.remaining });
      } catch {
        // Silently fail
      }
    },

    updateRecordingStatus: async (desktopId, workspaceId, status) => {
      set({ recordingStatus: status });
      try {
        await invoke("update_recording_status", {
          desktopId,
          workspaceId,
          status,
        });
      } catch {
        // Fire-and-forget: don't propagate errors
      }
    },
  }),
);

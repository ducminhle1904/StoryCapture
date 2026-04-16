/**
 * Zustand store for web account connection state.
 *
 * Manages the OAuth connect/disconnect flow and account info
 * retrieved from the OS keychain via Tauri commands.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { WebAccountInfo } from "@storycapture/shared-types";

export interface WebAccountStore {
  account: WebAccountInfo | null;
  isConnecting: boolean;
  error: string | null;
  // Actions
  fetchAccount: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  clearError: () => void;
}

export const useWebAccountStore = create<WebAccountStore>((set) => ({
  account: null,
  isConnecting: false,
  error: null,

  fetchAccount: async () => {
    try {
      const account = await invoke<WebAccountInfo | null>("get_web_account");
      set({ account, error: null });
    } catch {
      // Keychain unavailable or corrupt data — treat as disconnected
      set({ account: null });
    }
  },

  connect: async () => {
    set({ isConnecting: true, error: null });
    try {
      // Step 1: Start OAuth flow (opens browser, spawns callback server)
      await invoke<number>("start_web_oauth");

      // Step 2: Wait for the callback and exchange token
      const account = await invoke<WebAccountInfo>("complete_web_oauth");
      set({ account, isConnecting: false, error: null });
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed. Please try again.";
      set({ isConnecting: false, error: message });
    }
  },

  disconnect: async () => {
    try {
      await invoke("disconnect_web_account");
      set({ account: null, error: null });
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to disconnect. Please try again.";
      set({ error: message });
    }
  },

  clearError: () => set({ error: null }),
}));

import { create } from "zustand";

import {
  getAppSettings,
  resetAppSettingsCategory,
  setAppSettings,
  type AppSettings,
  type AppSettingsUpdate,
  type CaptureDefaults,
  type GeneralSettings,
  type PrivacySettings,
  type RenderDefaults,
  type SettingsCategory,
  type UpdateSettings,
} from "@/ipc/settings";

interface AppSettingsState {
  settings: AppSettings | null;
  loading: boolean;
  loadError: string | null;
  hydrate: () => Promise<AppSettings>;
  save: (update: AppSettingsUpdate) => Promise<AppSettings>;
  patchGeneral: (patch: Partial<GeneralSettings>) => Promise<AppSettings>;
  patchCapture: (patch: Partial<CaptureDefaults>) => Promise<AppSettings>;
  patchRender: (patch: Partial<RenderDefaults>) => Promise<AppSettings>;
  patchPrivacy: (patch: Partial<PrivacySettings>) => Promise<AppSettings>;
  patchUpdates: (patch: Partial<UpdateSettings>) => Promise<AppSettings>;
  resetCategory: (category: SettingsCategory) => Promise<AppSettings>;
}

export function updateFromSettings(s: AppSettings): AppSettingsUpdate {
  return {
    general: s.general,
    capture: s.capture,
    render: s.render,
    privacy: s.privacy,
    updates: s.updates,
  };
}

export const useAppSettingsStore = create<AppSettingsState>((set, get) => ({
  settings: null,
  loading: false,
  loadError: null,
  hydrate: async () => {
    const current = get().settings;
    if (current) return current;
    set({ loading: true, loadError: null });
    try {
      const settings = await getAppSettings();
      set({ settings, loading: false });
      return settings;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, loadError: message });
      throw err;
    }
  },
  save: async (update) => {
    const settings = await setAppSettings(update);
    set({ settings, loadError: null });
    return settings;
  },
  patchGeneral: async (patch) => {
    const base = get().settings ?? (await get().hydrate());
    return get().save({
      ...updateFromSettings(base),
      general: { ...base.general, ...patch },
    });
  },
  patchCapture: async (patch) => {
    const base = get().settings ?? (await get().hydrate());
    return get().save({
      ...updateFromSettings(base),
      capture: { ...base.capture, ...patch },
    });
  },
  patchRender: async (patch) => {
    const base = get().settings ?? (await get().hydrate());
    return get().save({
      ...updateFromSettings(base),
      render: { ...base.render, ...patch },
    });
  },
  patchPrivacy: async (patch) => {
    const base = get().settings ?? (await get().hydrate());
    return get().save({
      ...updateFromSettings(base),
      privacy: { ...base.privacy, ...patch },
    });
  },
  patchUpdates: async (patch) => {
    const base = get().settings ?? (await get().hydrate());
    return get().save({
      ...updateFromSettings(base),
      updates: { ...base.updates, ...patch },
    });
  },
  resetCategory: async (category) => {
    const settings = await resetAppSettingsCategory(category);
    set({ settings, loadError: null });
    return settings;
  },
}));

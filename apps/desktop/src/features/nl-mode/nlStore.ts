/**
 * Zustand store for NL Mode ephemeral chat UI state (Plan 03-17).
 *
 * Persists panelWidth + panelCollapsed to localStorage key "nl-mode.panel".
 * All other state is session-ephemeral.
 */

import { create } from "zustand";

export interface DiffCard {
  stepId: string;
  status: "pending" | "approved" | "rejected" | "regenerating";
  oldText?: string;
  newText?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface NlStore {
  panelWidth: number;
  panelCollapsed: boolean;
  streaming: { taskId: string; text: string } | null;
  pendingCards: DiffCard[];
  error: {
    kind: "network" | "rate_limit" | "auth";
    message: string;
    retryAfterS?: number;
  } | null;
  messages: ChatMessage[];
  // actions
  setPanelWidth: (w: number) => void;
  togglePanel: () => void;
  beginStream: (taskId: string) => void;
  appendStream: (delta: string) => void;
  endStream: () => void;
  setCards: (cards: DiffCard[]) => void;
  clearCardsForTask: (taskId: string) => void;
  updateCardStatus: (
    stepId: string,
    status: DiffCard["status"],
  ) => void;
  setError: (e: NlStore["error"]) => void;
  addMessage: (msg: ChatMessage) => void;
}

const STORAGE_KEY = "nl-mode.panel";

function loadPersistedPanel(): { panelWidth: number; panelCollapsed: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        panelWidth:
          typeof parsed.panelWidth === "number" ? parsed.panelWidth : 420,
        panelCollapsed:
          typeof parsed.panelCollapsed === "boolean"
            ? parsed.panelCollapsed
            : false,
      };
    }
  } catch {
    // ignore parse errors
  }
  return { panelWidth: 420, panelCollapsed: false };
}

function persistPanel(width: number, collapsed: boolean): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ panelWidth: width, panelCollapsed: collapsed }),
    );
  } catch {
    // ignore quota errors
  }
}

const initial = loadPersistedPanel();

export const useNlStore = create<NlStore>((set, get) => ({
  panelWidth: initial.panelWidth,
  panelCollapsed: initial.panelCollapsed,
  streaming: null,
  pendingCards: [],
  error: null,
  messages: [],

  setPanelWidth: (w: number) => {
    set({ panelWidth: w });
    persistPanel(w, get().panelCollapsed);
  },

  togglePanel: () => {
    const next = !get().panelCollapsed;
    set({ panelCollapsed: next });
    persistPanel(get().panelWidth, next);
  },

  beginStream: (taskId: string) => {
    set({ streaming: { taskId, text: "" }, error: null });
  },

  appendStream: (delta: string) => {
    const s = get().streaming;
    if (s) {
      set({ streaming: { ...s, text: s.text + delta } });
    }
  },

  endStream: () => {
    const s = get().streaming;
    if (s && s.text) {
      const msg: ChatMessage = {
        id: s.taskId,
        role: "assistant",
        text: s.text,
        timestamp: Date.now(),
      };
      set((state) => ({
        streaming: null,
        messages: [...state.messages, msg],
      }));
    } else {
      set({ streaming: null });
    }
  },

  setCards: (cards: DiffCard[]) => {
    set({ pendingCards: cards });
  },

  clearCardsForTask: (_taskId: string) => {
    set({ pendingCards: [] });
  },

  updateCardStatus: (stepId: string, status: DiffCard["status"]) => {
    set((state) => ({
      pendingCards: state.pendingCards.map((c) =>
        c.stepId === stepId ? { ...c, status } : c,
      ),
    }));
  },

  setError: (e) => {
    set({ error: e });
  },

  addMessage: (msg: ChatMessage) => {
    set((state) => ({ messages: [...state.messages, msg] }));
  },
}));

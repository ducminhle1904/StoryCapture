/**
 * VoiceCatalogDialog + VoicePresetCard tests.
 *
 * 7 behaviors:
 * 1. Dialog opens with the full library and renders >= 6 cards
 * 2. Header renders current library metadata
 * 3. Filter by locale 'en' narrows the list
 * 4. Clicking "Preview" calls tts_generate with sample, plays Audio
 * 5. Empty filter state renders current no-match copy
 * 6. No API key -> renders current provider-empty state + Settings CTA
 * 7. At most 2 presets show Featured badge (accent rule #6)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { VoiceCatalogDialog } from "./VoiceCatalogDialog";
import { useVoiceoverStore } from "./voiceoverStore";

// Mock Tauri invoke
const { mockInvoke } = vi.hoisted(() => {
  const mockInvoke = vi.fn();
  return { mockInvoke };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

// Mock Audio
const mockPlay = vi.fn().mockResolvedValue(undefined);

class MockAudio {
  src: string;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  play = mockPlay;
  constructor(src?: string) {
    this.src = src ?? "";
  }
}

vi.stubGlobal("Audio", MockAudio);

function renderDialog() {
  return render(
    <MemoryRouter>
      <VoiceCatalogDialog projectId="proj-1" />
    </MemoryRouter>,
  );
}

const sampleVoices = [
  { id: "v1", name: "Bella", locale: "en", premium: false },
  { id: "v2", name: "Adam", locale: "en", premium: false },
  { id: "v3", name: "Rachel", locale: "en", premium: true },
  { id: "v4", name: "Linh", locale: "vi", premium: false },
  { id: "v5", name: "Ngoc", locale: "vi", premium: false },
  { id: "v6", name: "Sam", locale: "en", premium: false },
  { id: "v7", name: "Emi", locale: "ja", premium: true },
  { id: "v8", name: "Hans", locale: "de", premium: false },
];

describe("VoiceCatalogDialog", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockPlay.mockClear();
    useVoiceoverStore.setState({
      selectedPreset: null,
      catalogOpen: true,
      filter: {},
      clipByStepId: {},
      generating: new Set(),
      scriptByStepId: {},
      editedAfterGenByStepId: {},
    });
    // Default: voice list returns sample voices
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "tts_voice_list") return Promise.resolve(sampleVoices);
      if (cmd === "tts_generate")
        return Promise.resolve({
          file_path: "/tmp/preview.mp3",
          audio_duration_ms: 1200,
          cost_usd: 0.01,
          cache_hit: false,
        });
      return Promise.resolve(null);
    });
  });

  it("opens with the full library and renders >= 6 cards", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("voice-catalog")).toBeTruthy();
    });
    const cards = screen.getAllByTestId("voice-preset-card");
    expect(cards.length).toBeGreaterThanOrEqual(6);
  });

  it("renders current selection and library metadata", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("voice-catalog")).toBeTruthy();
    });
    expect(screen.getByText("No voice selected")).toBeTruthy();
    expect(screen.getByText(`${sampleVoices.length} available`)).toBeTruthy();
    expect(screen.getByText("Full library")).toBeTruthy();
  });

  it("filters by locale 'en' and narrows the list", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getAllByTestId("voice-preset-card").length).toBeGreaterThanOrEqual(6);
    });
    const enChip = screen.getByRole("radio", { name: /en/i });
    await act(async () => {
      fireEvent.click(enChip);
    });
    await waitFor(() => {
      const cards = screen.getAllByTestId("voice-preset-card");
      // Only en-locale voices: v1, v2, v3, v6 = 4
      expect(cards.length).toBeLessThan(8);
      expect(cards.length).toBeGreaterThanOrEqual(4);
    });
  });

  it("plays preview on 'Preview' click via Audio element", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getAllByTestId("voice-preset-card").length).toBeGreaterThanOrEqual(1);
    });
    const previewBtns = screen.getAllByLabelText(/Preview voice/i);
    await act(async () => {
      fireEvent.click(previewBtns[0]);
      // Allow the async invoke chain to resolve
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "tts_generate",
        expect.objectContaining({
          stepId: "preview",
          scriptText: "This is a sample narration.",
        }),
      );
    });
    expect(mockPlay).toHaveBeenCalled();
  });

  it("renders empty filter state copy when no voices match", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getAllByTestId("voice-preset-card").length).toBeGreaterThanOrEqual(1);
    });
    // Set filter to a locale with no voices
    act(() => {
      useVoiceoverStore.getState().setFilter({ locale: "xx" });
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Nothing matches these filters/),
      ).toBeTruthy();
    });
  });

  it("renders no-provider empty state when API key missing", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "tts_voice_list")
        return Promise.reject(new Error("no API key stored for this provider"));
      return Promise.resolve(null);
    });
    renderDialog();
    await waitFor(() => {
      expect(
        screen.getByText(/Connect a provider first/),
      ).toBeTruthy();
    });
    expect(screen.getByText(/Open settings/)).toBeTruthy();
  });

  it("shows at most 2 Featured badges", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getAllByTestId("voice-preset-card").length).toBeGreaterThanOrEqual(1);
    });
    const featuredBadges = screen.queryAllByText("Featured");
    expect(featuredBadges.length).toBeLessThanOrEqual(2);
  });
});

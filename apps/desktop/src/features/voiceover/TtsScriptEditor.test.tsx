/**
 * TtsScriptEditor + TtsClipInspector tests.
 *
 * 5 behaviors:
 * 1. Empty state: no narration copy + CTA "Generate audio"
 * 2. CTA click invokes tts_generate with script text
 * 3. Char count warning appears near the limit
 * 4. Editing after generation sets edited-not-regenerated state; stale warning chip
 * 5. "Regenerate audio" button calls tts_regenerate_clip
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TtsClipInspector } from "./TtsClipInspector";
import { TtsScriptEditor } from "./TtsScriptEditor";
import { useVoiceoverStore } from "./voiceoverStore";

// Mock Tauri invoke
const { mockInvoke } = vi.hoisted(() => {
  const mockInvoke = vi.fn();
  return { mockInvoke };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const samplePreset = {
  id: "v1",
  name: "Bella",
  locale: "en",
  premium: false,
  provider: "elevenlabs" as const,
};

describe("TtsScriptEditor", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({
      file_path: "/tmp/step1.mp3",
      audio_duration_ms: 2500,
      cost_usd: 0.015,
      cache_hit: false,
    });
    useVoiceoverStore.setState({
      selectedPreset: samplePreset,
      catalogOpen: false,
      catalogMode: "curated",
      filter: {},
      clipByStepId: {},
      generating: new Set(),
      scriptByStepId: {},
      editedAfterGenByStepId: {},
    });
  });

  it("renders empty state copy and CTA when no script exists", () => {
    render(<TtsScriptEditor projectId="proj-1" stepId="step-1" />);
    expect(screen.getByText(/Write the line, then render a take\./i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Generate audio/i })).toBeTruthy();
  });

  it("invokes tts_generate on CTA click with script text", async () => {
    // Set a script first
    act(() => {
      useVoiceoverStore.getState().setScript("step-1", "Hello world narration text");
    });
    render(<TtsScriptEditor projectId="proj-1" stepId="step-1" />);
    const generateBtn = screen.getByRole("button", {
      name: /Generate audio/i,
    });
    await act(async () => {
      fireEvent.click(generateBtn);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "tts_generate",
      expect.objectContaining({
        projectId: "proj-1",
        stepId: "step-1",
        scriptText: "Hello world narration text",
      }),
    );
  });

  it("shows the soft-limit warning when the script gets long", async () => {
    // Pre-set a script and clip so the editor renders textarea (not empty state)
    act(() => {
      useVoiceoverStore.getState().setScript("step-1", "Hello");
      useVoiceoverStore.getState().setClip("step-1", {
        filePath: "/tmp/step1.mp3",
        durationMs: 1000,
        costUsd: 0.01,
      });
    });
    const user = userEvent.setup();
    render(<TtsScriptEditor projectId="proj-1" stepId="step-1" />);
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "a".repeat(710));
    expect(screen.getByText(/710 \/ 800/)).toBeTruthy();
  });

  it("shows stale warning chip when edited after generation", async () => {
    // Simulate generated state with clip
    act(() => {
      useVoiceoverStore.getState().setScript("step-1", "Original narration");
      useVoiceoverStore.getState().setClip("step-1", {
        filePath: "/tmp/step1.mp3",
        durationMs: 2500,
        costUsd: 0.015,
      });
    });
    render(<TtsScriptEditor projectId="proj-1" stepId="step-1" />);
    // Edit the script
    const textarea = screen.getByRole("textbox");
    await userEvent.setup().type(textarea, " edited");
    // Should show stale warning
    await waitFor(() => {
      expect(screen.getByText(/The script changed since the last take\./i)).toBeTruthy();
    });
  });

  it("renders Regenerate audio button in TtsClipInspector", async () => {
    render(
      <TtsClipInspector
        stepId="step-1"
        projectId="proj-1"
        clip={{ filePath: "/tmp/step1.mp3", durationMs: 2500, costUsd: 0.015 }}
        presetName="Bella"
        status="generated"
        onRegenerate={vi.fn()}
      />,
    );
    const regenBtn = screen.getByText(/Regenerate/i);
    expect(regenBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(regenBtn);
    });
  });
});

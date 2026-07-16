/**
 * ExportModal tests. Coverage:
 *   - Export button disabled when no formats selected
 *   - Selecting MP4 + 1080p + 60fps + medium + picking a folder enables
 *     submit, and clicking Export calls `export_run` with the right shape
 *   - typed `export_preflight` failures surface as warnings
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri invoke mock — must be declared via vi.mock BEFORE importing modules
// that read from @tauri-apps/api/core.
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {
    onmessage: ((p: unknown) => void) | null = null;
  },
  convertFileSrc: (s: string) => s,
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { RENDER_KEYS } from "@/ipc/render";
import { DEFAULT_EXPORT_KNOBS, useOutputPrefsStore } from "@/state/output-prefs";
// Re-import AFTER the mock is in place.
import { ExportModal } from "../export-modal/export-modal";
import { DEFAULT_EXPORT_FORM } from "../state/export-slice";
import { useEditorStore } from "../state/store";

function Wrapped({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function resetStore() {
  useOutputPrefsStore.setState({ exportKnobs: { ...DEFAULT_EXPORT_KNOBS } });
  useEditorStore.setState({
    tracks: { video: [], cursor: [], zoom: [], sound: [], annotations: [] },
    playheadMs: 0,
    snapEnabled: true,
    durationMs: 0,
    selectedClipId: null,
    selectedPresetId: null,
    selectedTab: "presets",
    soundDrawerOpen: false,
    exportModalOpen: true,
    activeJobs: {},
    progressByJobId: {},
    exportForm: {
      ...DEFAULT_EXPORT_FORM,
      formats: ["mp4"],
      resolution: "1080p",
      fps: 60,
      quality: "med",
      outFolder: null,
      baseName: "export",
    },
  });
}

function successfulPreflight() {
  return {
    ready: true,
    composition_duration_ms: 1_000,
    issues: [],
    outputs: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockReset();
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExportModal", () => {
  it("disables Export when no formats are selected", () => {
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: [],
        resolution: "1080p",
        fps: 60,
        quality: "med",
        outFolder: "/tmp/out",
        baseName: "export",
      },
    });
    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );
    const btn = screen.getByRole("button", { name: /start export/i });
    expect(btn).toBeDisabled();
  });

  it("keeps Export disabled when timeline has no renderable video clip", () => {
    // Form is valid but the video track is empty, so computeGraph yields
    // a graph with no video nodes — submission must stay blocked to
    // prevent empty-graph jobs reaching the backend.
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: ["mp4"],
        resolution: "1080p",
        fps: 60,
        quality: "med",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });

    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );

    const btn = screen.getByRole("button", { name: /start export/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/sourcePath/i);
  });

  it("enables Export once a video clip with sourcePath is present", () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: ["mp4"],
        resolution: "1080p",
        fps: 60,
        quality: "med",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });

    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );

    const btn = screen.getByRole("button", { name: /start export/i });
    expect(btn).not.toBeDisabled();
  });

  it.each([
    true,
    false,
  ])("wires TTS disclosure with embed_xmp=%s through preflight and export_run", async (embedXmp) => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [
          {
            id: "tts-1",
            trackId: "sound",
            startMs: 0,
            durationMs: 1000,
            path: "/tmp/voice.wav",
            kind: "voiceover",
          },
        ],
        annotations: [],
      },
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: ["mp4"],
        resolution: "1080p",
        fps: 60,
        quality: "high",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_preflight") return Promise.resolve(successfulPreflight());
      if (cmd === "export_run") {
        return Promise.resolve({
          batch_id: "b1",
          job_ids: ["j1"],
          graph_snapshot_path: "/tmp/graph.json",
        });
      }
      return Promise.resolve(null);
    });

    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );
    fireEvent.click(screen.getByRole("button", { name: /start export/i }));
    const checkbox = await screen.findByRole("checkbox", {
      name: /Embed AI-generated voice metadata \(XMP\)/i,
    });
    if (!embedXmp) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /export anyway/i }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("export_run", expect.anything()));
    for (const command of ["export_preflight", "export_run"]) {
      expect(mockInvoke).toHaveBeenCalledWith(command, {
        args: expect.objectContaining({
          ai_disclosure: {
            contains_ai_voiceover: true,
            embed_xmp: embedXmp,
          },
        }),
      });
    }
  });

  it("includes editor background in exported graph_json only for framed exports", async () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark" },
      },
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: ["mp4"],
        resolution: "1080p",
        fps: 60,
        quality: "med",
        frameMode: "framed",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_preflight") return Promise.resolve(successfulPreflight());
      if (cmd === "export_run") {
        return Promise.resolve({
          batch_id: "b1",
          job_ids: ["j1"],
          graph_snapshot_path: "/tmp/graph.json",
        });
      }
      return Promise.resolve(null);
    });
    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );

    fireEvent.click(screen.getByRole("button", { name: /start export/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "export_run",
        expect.objectContaining({ args: expect.any(Object) }),
      );
    });
    const exportCall = mockInvoke.mock.calls.find(([cmd]) => cmd === "export_run");
    const args = exportCall?.[1] as { args: { graph_json: string } };
    const graph = JSON.parse(args.args.graph_json) as {
      video: Array<{ type: string; kind?: unknown }>;
    };
    expect(graph.video).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "background",
          kind: { kind: "gradient", preset_id: "runway-dark" },
        }),
      ]),
    );
  });

  it("passes advanced encoder options through export_run per output format", async () => {
    useOutputPrefsStore.setState({
      exportKnobs: {
        ...DEFAULT_EXPORT_KNOBS,
        hwEncoder: "software",
        rateControl: "crf",
        qualityValue: 14,
        encoderPreset: "slow",
        keyframeSec: 4,
        resamplingQuality: "balanced",
        audio: { codec: "aac", bitrateKbps: 192, channels: 1, sampleRateHz: 44_100 },
      },
    });
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: ["mp4", "webm"],
        resolution: "1080p",
        fps: 60,
        quality: "high",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_preflight") return Promise.resolve(successfulPreflight());
      if (cmd === "export_run") {
        return Promise.resolve({
          batch_id: "b1",
          job_ids: ["j1", "j2"],
          graph_snapshot_path: "/tmp/graph.json",
        });
      }
      return Promise.resolve(null);
    });
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );

    fireEvent.click(screen.getByRole("button", { name: /start export/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "export_run",
        expect.objectContaining({ args: expect.any(Object) }),
      );
    });
    const exportCall = mockInvoke.mock.calls.find(([cmd]) => cmd === "export_run");
    const args = exportCall?.[1] as {
      args: { outputs: Array<{ format: string; encoder_options: Record<string, unknown> }> };
    };

    expect(args.args.outputs[0]).toMatchObject({
      format: "mp4",
      encoder_options: {
        container: "mp4",
        rate_control: "crf",
        hw_encoder: "libx264-software",
        quality_value: 14,
        encoder_preset: "slow",
        keyframe_interval_sec: 4,
        resampling_quality: "balanced",
        audio: {
          codec: "aac",
          bitrate_kbps: 192,
          channels: 1,
          sample_rate_hz: 44_100,
        },
      },
    });
    expect(args.args.outputs[0]?.encoder_options).not.toHaveProperty("x264_preset");
    expect(args.args.outputs[0]?.encoder_options).not.toHaveProperty("downscale_algo");
    expect(args.args.outputs[1]).toMatchObject({
      format: "webm",
      encoder_options: {
        container: "webm",
        audio: { codec: "opus" },
      },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: RENDER_KEYS.listActive("s1") });
    expect(toast.success).toHaveBeenCalledWith("Export started: 2 jobs queued");
  });

  it("surfaces export_run fail-fast errors in the warning panel", async () => {
    useEditorStore.setState({
      tracks: {
        video: [
          {
            id: "v1",
            trackId: "video",
            startMs: 0,
            durationMs: 1000,
            sourcePath: "/tmp/in.mp4",
          },
        ],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: ["mp4"],
        resolution: "1080p",
        fps: 60,
        quality: "high",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_preflight") return Promise.resolve(successfulPreflight());
      if (cmd === "export_run") {
        return Promise.reject(new Error("mp4 export is unsupported: text-overlay"));
      }
      return Promise.resolve(null);
    });

    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );

    fireEvent.click(screen.getByRole("button", { name: /start export/i }));

    await waitFor(() => {
      expect(screen.getByText(/mp4 export is unsupported: text-overlay/i)).toBeInTheDocument();
    });
  });

  it("surfaces validation failures as warning text and keeps submit disabled", async () => {
    useEditorStore.setState({
      exportForm: {
        ...DEFAULT_EXPORT_FORM,
        formats: ["gif"],
        resolution: "4k",
        fps: 60,
        quality: "high",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_preflight") {
        return Promise.resolve({
          ready: false,
          composition_duration_ms: 1_000,
          issues: [
            {
              id: "output.invalid-config:0",
              code: "output.invalid-config",
              severity: "error",
              message: "GIF does not support 4K",
              output_index: 0,
            },
          ],
          outputs: [],
        });
      }
      return Promise.resolve(null);
    });

    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );

    fireEvent.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => {
      expect(screen.getByText(/GIF does not support 4K/i)).toBeInTheDocument();
    });

    const btn = screen.getByRole("button", { name: /start export/i });
    expect(btn).toBeDisabled();
  });
});

/**
 * ExportModal tests. Coverage:
 *   - Export button disabled when no formats selected
 *   - Selecting MP4 + 1080p + 60fps + medium + picking a folder enables
 *     submit, and clicking Export calls `export_run` with the right shape
 *   - `export_validate_config` failures surface as warnings
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

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

// Re-import AFTER the mock is in place.
import { ExportModal } from "../export-modal/export-modal";
import { useEditorStore } from "../state/store";

function Wrapped({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function resetStore() {
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
      formats: ["mp4"],
      resolution: "1080p",
      fps: 60,
      quality: "med",
      outFolder: null,
      baseName: "export",
    },
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  resetStore();
});

describe("ExportModal", () => {
  it("disables Export when no formats are selected", () => {
    useEditorStore.setState({
      exportForm: {
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

  it("includes editor background in exported graph_json", async () => {
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
        formats: ["mp4"],
        resolution: "1080p",
        fps: 60,
        quality: "med",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_validate_config") return Promise.resolve(null);
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

  it("surfaces validation failures as warning text and keeps submit disabled", async () => {
    useEditorStore.setState({
      exportForm: {
        formats: ["gif"],
        resolution: "4k",
        fps: 60,
        quality: "high",
        outFolder: "/tmp/out",
        baseName: "demo",
      },
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_validate_config") {
        return Promise.reject("GIF does not support 4K");
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
      expect(
        screen.getByText(/GIF does not support 4K/i),
      ).toBeInTheDocument();
    });

    const btn = screen.getByRole("button", { name: /start export/i });
    expect(btn).toBeDisabled();
  });
});

/**
 * ExportModal tests (Plan 02-12b, Task 2).
 *
 * Coverage:
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

  it("enables Export once formats + folder are set; invokes export_run with correct outputs", async () => {
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

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "export_validate_config") return Promise.resolve(undefined);
      if (cmd === "export_run") {
        return Promise.resolve({
          batch_id: "b1",
          job_ids: ["j1"],
          graph_snapshot_path: "/tmp/snap.json",
        });
      }
      return Promise.resolve(null);
    });

    render(
      <Wrapped>
        <ExportModal storyId="s1" />
      </Wrapped>,
    );

    const btn = screen.getByRole("button", { name: /start export/i });
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);

    await waitFor(() => {
      const exportCall = mockInvoke.mock.calls.find(
        (c) => c[0] === "export_run",
      );
      expect(exportCall).toBeDefined();
    });

    const exportCall = mockInvoke.mock.calls.find((c) => c[0] === "export_run")!;
    const payload = exportCall[1] as { args: { outputs: unknown[]; story_id: string; output_folder: string } };
    expect(payload.args.story_id).toBe("s1");
    expect(payload.args.output_folder).toBe("/tmp/out");
    expect(payload.args.outputs).toHaveLength(1);
    expect(payload.args.outputs[0]).toMatchObject({
      format: "mp4",
      resolution: "1080p",
      fps: 60,
      quality: "med",
    });
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

import { render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RenderProgress } from "@/ipc/render";

const mockInvoke = vi.fn();
const channels: Array<{ onmessage: ((p: RenderProgress) => void) | null }> = [];
let resolveInvoke: (() => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {
    onmessage: ((p: RenderProgress) => void) | null = null;

    constructor() {
      channels.push(this);
    }
  },
}));

vi.mock("@/lib/log", () => ({
  frontendLog: {
    warn: vi.fn(),
  },
}));

import { useEditorStore } from "../state/store";
import { useRenderProgress } from "./use-render-progress";

function Probe() {
  const progressMap = useRenderProgress();
  return <div data-pct={progressMap["job-1"]?.pct ?? 0} />;
}

function resetStore() {
  useEditorStore.setState({
    activeJobs: {},
    progressByJobId: {},
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  channels.length = 0;
  resolveInvoke = null;
  resetStore();
  mockInvoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveInvoke = resolve;
      }),
  );
});

describe("useRenderProgress", () => {
  it("opens only one render progress stream under StrictMode", async () => {
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    expect(mockInvoke).toHaveBeenCalledWith("stream_render_progress", {
      channel: channels[0],
    });
    resolveInvoke?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("mirrors channel progress into the editor store", async () => {
    render(<Probe />);

    await waitFor(() => expect(channels).toHaveLength(1));
    channels[0]?.onmessage?.({
      job_id: "job-1",
      status: "rendering",
      pct: 42,
      phase_pct: 35,
      frame: 120,
      fps: 60,
      speed: 1,
      eta_ms: 1000,
    });

    await waitFor(() => {
      expect(useEditorStore.getState().progressByJobId["job-1"]?.pct).toBe(42);
    });
  });
});

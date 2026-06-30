import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RenderJob } from "@/ipc/render";

vi.mock("@/ipc/render", () => ({
  RENDER_KEYS: {
    listActive: (storyId: string) => ["render", "list-active", storyId] as const,
  },
  renderCancel: vi.fn(),
  renderListActive: vi.fn(),
}));

vi.mock("../hooks/use-render-progress", () => ({
  useRenderProgress: () => ({}),
}));

import { renderListActive } from "@/ipc/render";
import { QueueWidget } from "./queue-widget";

const mockRenderListActive = vi.mocked(renderListActive);

function makeJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: "job-1",
    story_id: "story-1",
    preset_id: null,
    format: "mp4",
    resolution: "1080p",
    fps: 60,
    quality: "high",
    status: "running",
    progress_pct: 25,
    started_at: 1,
    completed_at: null,
    error: null,
    priority: 0,
    output_path: null,
    batch_id: "batch-1",
    created_at: 1,
    ...overrides,
  };
}

function Wrapped({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockRenderListActive.mockReset();
});

describe("QueueWidget", () => {
  it("keeps the empty Queue label and concise empty state", async () => {
    mockRenderListActive.mockResolvedValue([]);

    render(
      <Wrapped>
        <QueueWidget storyId="story-1" />
      </Wrapped>,
    );

    const button = screen.getByRole("button", { name: "Queue" });
    fireEvent.click(button);

    expect(await screen.findByRole("heading", { name: "Render queue" })).toBeInTheDocument();
    expect(screen.getByText("No active exports.")).toBeInTheDocument();
  });

  it("shows an active export label when jobs exist", async () => {
    mockRenderListActive.mockResolvedValue([makeJob()]);

    render(
      <Wrapped>
        <QueueWidget storyId="story-1" />
      </Wrapped>,
    );

    expect(await screen.findByRole("button", { name: "1 export active" })).toBeInTheDocument();
  });
});

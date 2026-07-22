import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RenderJob, RenderProgress } from "@/ipc/render";
import { JobRow } from "./job-row";

function makeJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: "job-1",
    story_id: "story-1",
    preset_id: null,
    format: "mp4",
    resolution: "1080p",
    fps: 60,
    quality: "high",
    status: "rendering",
    progress_pct: 0,
    phase_progress_pct: 0,
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

function makeProgress(overrides: Partial<RenderProgress> = {}): RenderProgress {
  return {
    job_id: "job-1",
    status: "rendering",
    pct: 43.4,
    phase_pct: 28,
    frame: 120,
    fps: 58.5,
    speed: 1.2,
    eta_ms: 65_000,
    ...overrides,
  };
}

describe("JobRow", () => {
  it("renders visible percent from live progress", () => {
    render(
      <JobRow job={makeJob({ progress_pct: 12 })} progress={makeProgress()} onCancel={vi.fn()} />,
    );

    expect(screen.getByText("43% complete")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: /mp4 1080p @ 60fps progress/i }),
    ).toHaveAttribute("aria-valuenow", "43");
  });

  it("renders formatted ETA from eta_ms", () => {
    render(
      <JobRow job={makeJob()} progress={makeProgress({ eta_ms: 65_000 })} onCancel={vi.fn()} />,
    );

    expect(screen.getByText("Rendering · 28%")).toBeInTheDocument();
    expect(screen.getByText("ETA 1m 05s")).toBeInTheDocument();
  });

  it("shows fallback text when progress is missing", () => {
    render(
      <JobRow
        job={makeJob({ status: "queued", progress_pct: 8, phase_progress_pct: 0 })}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("8% complete")).toBeInTheDocument();
    expect(screen.getByText("Queued · 0%")).toBeInTheDocument();
  });

  it("does not show active ETA copy for cancelled jobs", () => {
    render(
      <JobRow
        job={makeJob({ status: "cancelled", progress_pct: 40 })}
        progress={makeProgress({ eta_ms: 30_000 })}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText(/ETA/)).not.toBeInTheDocument();
  });

  it("does not expose raw failed export errors in the compact row", () => {
    render(
      <JobRow
        job={makeJob({
          status: "failed",
          error: "ffmpeg failed for /Users/demo/private/source.mp4",
        })}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.queryByText("ffmpeg failed for /Users/demo/private/source.mp4"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Failed")).toHaveAttribute("title", "Failed");
    expect(
      screen.getByText(
        "Check source media, output permissions, and available disk space, then retry.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the final path only after completion", () => {
    render(
      <JobRow
        job={makeJob({
          status: "completed",
          progress_pct: 100,
          phase_progress_pct: 100,
          output_path: "/Users/demo/Exports/story.mp4",
        })}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Saved to /Users/demo/Exports/story.mp4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("keeps Strict Local provenance visible after export", () => {
    render(
      <JobRow
        job={makeJob({ recording_mode: "strict_local" })}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Strict Local — runtime-verified; upload and sharing are disabled"),
    ).toBeVisible();
  });
});

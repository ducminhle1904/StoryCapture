import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  projectRecordingsQueryKey,
  publishCompletedRecording,
  type RecordingInfo,
  workflowTypeToWeb,
} from "./projects";

describe("project workflow sync helpers", () => {
  it("maps local workflow types to web enum values", () => {
    expect(workflowTypeToWeb("product_demo")).toBe("PRODUCT_DEMO");
    expect(workflowTypeToWeb("feature_launch")).toBe("FEATURE_LAUNCH");
    expect(workflowTypeToWeb("bug_reproduction")).toBe("BUG_REPRODUCTION");
    expect(workflowTypeToWeb("freestyle")).toBe("FREESTYLE");
  });
});

describe("publishCompletedRecording", () => {
  function recording(path: string, capturedAt: number): RecordingInfo {
    return { path, captured_at: capturedAt, duration_ms: null, width: null, height: null };
  }

  it("publishes the first recording into an empty cache", () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const completed = recording("/exports/first.mp4", 1);

    publishCompletedRecording(queryClient, "project-1", completed);

    expect(queryClient.getQueryData(projectRecordingsQueryKey("project-1"))).toEqual([completed]);
  });

  it("publishes the completed recording first and deduplicates its path", () => {
    const queryClient = new QueryClient();
    const key = projectRecordingsQueryKey("project-1");
    const previous: RecordingInfo = {
      path: "/exports/previous.mp4",
      captured_at: 1,
      duration_ms: null,
      width: null,
      height: null,
    };
    queryClient.setQueryData(key, [previous, { ...previous, path: "/exports/latest.mp4" }]);
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    const completed: RecordingInfo = {
      path: "/exports/latest.mp4",
      captured_at: 2,
      duration_ms: 3_000,
      width: 1920,
      height: 1080,
    };
    publishCompletedRecording(queryClient, "project-1", completed);

    expect(queryClient.getQueryData(key)).toEqual([completed, previous]);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: key });
  });

  it("makes a second recording immediately visible inside the query stale window", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
    const key = projectRecordingsQueryKey("project-1");
    const first = recording("/exports/first.mp4", 1);
    const second = recording("/exports/second.mp4", 2);
    queryClient.setQueryData(key, [first]);
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    publishCompletedRecording(queryClient, "project-1", second);

    expect(queryClient.getQueryData(key)).toEqual([second, first]);
  });

  it("does not mutate existing recordings when no completion is published", () => {
    const queryClient = new QueryClient();
    const key = projectRecordingsQueryKey("project-1");
    const existing = [recording("/exports/existing.mp4", 1)];
    queryClient.setQueryData(key, existing);

    expect(queryClient.getQueryData(key)).toEqual(existing);
  });
});

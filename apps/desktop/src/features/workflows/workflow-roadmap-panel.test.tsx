import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "@/ipc/projects";
import { WorkflowRoadmapPanel } from "./workflow-roadmap-panel";

const workflow: WorkflowState = {
  version: 1,
  type: "product_demo",
  createdAt: 1,
  updatedAt: 1,
  steps: [
    {
      id: "problem",
      title: "Frame the problem",
      status: "drafted",
      sceneName: "Problem",
      requiredInputs: ["problem"],
      notes: "Show current friction.",
    },
  ],
};

describe("WorkflowRoadmapPanel", () => {
  it("renders roadmap status and updates a step", () => {
    const onChange = vi.fn();

    render(<WorkflowRoadmapPanel workflow={workflow} onChange={onChange} />);

    expect(screen.getByText("Product Demo roadmap")).toBeInTheDocument();
    expect(screen.getByText("Frame the problem")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Recorded" }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [expect.objectContaining({ id: "problem", status: "recorded" })],
      }),
    );
  });
});

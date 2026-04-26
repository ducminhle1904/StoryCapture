import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "@/ipc/projects";
import { ProjectCard } from "./project-card";

const project: Project = {
  id: "018f4c4a-6f84-7a40-bc1f-c3f1fdf5b2c9",
  name: "Demo Project",
  folder_path: "/tmp/demo-project",
  created_at: Date.now(),
  last_opened_at: null,
  thumbnail_path: null,
};

describe("ProjectCard", () => {
  it("confirms before removing a project", async () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn().mockResolvedValue(undefined);

    render(<ProjectCard project={project} onOpen={onOpen} onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Demo Project from dashboard" }));

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Remove project?" })).toBeInTheDocument();
    expect(screen.getByText(/The project folder stays on disk/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(project));
  });

  it("keeps the more-actions placeholder when remove is not available", () => {
    render(<ProjectCard project={project} onOpen={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "More actions for Demo Project (coming soon)" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove Demo Project from dashboard" })).toBeNull();
  });
});

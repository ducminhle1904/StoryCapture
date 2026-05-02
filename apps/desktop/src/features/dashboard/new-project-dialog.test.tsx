import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewProjectDialog } from "./new-project-dialog";

const dialogOpenMock = vi.fn<() => Promise<string | null>>();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpenMock(...(args as [])),
}));

function renderDialog(onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewProjectDialog open onOpenChange={vi.fn()} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return { onCreated };
}

describe("NewProjectDialog", () => {
  beforeEach(() => {
    dialogOpenMock.mockResolvedValue("/tmp/storycapture-projects");
  });

  afterEach(() => {
    clearMocks();
    vi.clearAllMocks();
  });

  it("renders all guided workflow cards with roadmap details", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: /Product Demo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tutorial/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Feature Launch/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sales \/ Marketing Demo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Support \/ Troubleshooting/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Internal Training/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bug Reproduction/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Documentation Video/i })).toBeInTheDocument();
    expect(screen.getByText("Product Demo roadmap")).toBeInTheDocument();
  });

  it("creates a guided project with starter story and workflow metadata", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    let createArgs: unknown = null;
    mockIPC((cmd, args) => {
      if (cmd === "create_project") {
        createArgs = args;
        return {
          id: "018f4c4a-6f84-7a40-bc1f-c3f1fdf5b2c9",
          name: "Launch Demo",
          folder_path: "/tmp/storycapture-projects/launch-demo",
          created_at: Date.now(),
          last_opened_at: Date.now(),
          thumbnail_path: null,
        };
      }
      return undefined;
    });

    renderDialog(onCreated);

    await user.type(screen.getByLabelText("Name"), "Launch Demo");
    fireEvent.click(screen.getByRole("button", { name: "Browse for parent folder" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Parent folder path")).toHaveValue("/tmp/storycapture-projects"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Feature Launch/i }));
    await user.type(screen.getByLabelText("Target URL"), "https://app.story.test");
    fireEvent.click(screen.getByRole("button", { name: "Create Story" }));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith("018f4c4a-6f84-7a40-bc1f-c3f1fdf5b2c9"),
    );
    expect(createArgs).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          name: "Launch Demo",
          parent: "/tmp/storycapture-projects",
          workflow_type: "feature_launch",
          starter_story_source: expect.stringContaining('app: "https://app.story.test"'),
          workflow_state: expect.objectContaining({ type: "feature_launch" }),
        }),
      }),
    );
  });

  it("creates freestyle without guided metadata", async () => {
    const user = userEvent.setup();
    let createArgs: unknown = null;
    mockIPC((cmd, args) => {
      if (cmd === "create_project") {
        createArgs = args;
        return {
          id: "018f4c4a-6f84-7a40-bc1f-c3f1fdf5b2c9",
          name: "Blank Story",
          folder_path: "/tmp/storycapture-projects/blank-story",
          created_at: Date.now(),
          last_opened_at: Date.now(),
          thumbnail_path: null,
        };
      }
      return undefined;
    });

    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Blank Story");
    fireEvent.click(screen.getByRole("button", { name: "Browse for parent folder" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Parent folder path")).toHaveValue("/tmp/storycapture-projects"),
    );
    fireEvent.click(screen.getByText("Freestyle"));
    fireEvent.click(screen.getByRole("button", { name: "Create Story" }));

    await waitFor(() => expect(createArgs).not.toBeNull());
    expect(createArgs).toEqual({
      args: {
        name: "Blank Story",
        parent: "/tmp/storycapture-projects",
        workflow_type: undefined,
        starter_story_source: undefined,
        workflow_state: undefined,
      },
    });
  });
});

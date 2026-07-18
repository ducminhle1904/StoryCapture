import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readJson: vi.fn(),
  registryPath: "/tmp/storycapture/projects.json",
  writeJson: vi.fn(),
  writeJsonAtomic: vi.fn(),
}));

vi.mock("../json-store", () => ({
  readJson: mocks.readJson,
  writeJson: mocks.writeJson,
  writeJsonAtomic: mocks.writeJsonAtomic,
}));

vi.mock("../recording-discovery", () => ({
  discoverProjectRecordings: vi.fn(),
}));

vi.mock("./shared", () => ({
  ASSETS_DIRNAME: "assets",
  EXPORTS_DIRNAME: "exports",
  FOLDER_FORMAT_VERSION: "1",
  META_DIRNAME: ".storycapture",
  projectsRegistryPath: () => mocks.registryPath,
  STORY_FILENAME: "story.story",
  timelinePath: vi.fn(),
  VERSION_FILENAME: "version.txt",
  WORKFLOW_FILENAME: "workflow.json",
}));

import { writeProjects } from "./projects";

describe("project registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes project records atomically", async () => {
    const projects = [
      {
        id: "project-1",
        name: "Recovered project",
        folder_path: "/tmp/storycapture/recovered-project",
        created_at: 1,
        last_opened_at: 2,
        thumbnail_path: null,
      },
    ];

    await writeProjects(projects);

    expect(mocks.writeJsonAtomic).toHaveBeenCalledOnce();
    expect(mocks.writeJsonAtomic).toHaveBeenCalledWith(mocks.registryPath, projects);
  });
});

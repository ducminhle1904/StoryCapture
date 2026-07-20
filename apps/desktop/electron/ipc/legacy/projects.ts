import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import slugify from "@sindresorhus/slugify";
import { readJson, writeJson, writeJsonAtomic } from "../json-store";
import { cleanupPartialRecordingBundles } from "../recording-bundle";
import { discoverProjectRecordings } from "../recording-discovery";
import { cleanupExpiredFailedRecordingBundles } from "../recording-failed-bundle-retention";
import {
  ASSETS_DIRNAME,
  type CreateProjectArgs,
  EXPORTS_DIRNAME,
  FOLDER_FORMAT_VERSION,
  META_DIRNAME,
  type ProjectRecord,
  projectsRegistryPath,
  STORY_FILENAME,
  type TimelineState,
  timelinePath,
  VERSION_FILENAME,
  WORKFLOW_FILENAME,
  type WorkflowState,
} from "./shared";

export function defaultStarterStory(name: string): string {
  const safe = name.replaceAll('"', '\\"');
  return `story "${safe}" {\n  meta {\n    app: "https://example.com"\n    viewport: desktop\n    theme: dark\n    speed: 1.0\n  }\n\n  scene "${safe}" {\n    pause\n  }\n}\n`;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readProjects(): Promise<ProjectRecord[]> {
  const projects = await readJson<ProjectRecord[]>(projectsRegistryPath(), []);
  return projects
    .filter((project) => project && typeof project.id === "string")
    .sort((a, b) => (b.last_opened_at ?? b.created_at) - (a.last_opened_at ?? a.created_at));
}

export async function writeProjects(projects: ProjectRecord[]): Promise<void> {
  await writeJsonAtomic(projectsRegistryPath(), projects);
}

export async function findProject(id: string): Promise<ProjectRecord> {
  const project = (await readProjects()).find((candidate) => candidate.id === id);
  if (!project) throw new Error(`project ${id} not found`);
  return project;
}

export function projectPaths(folder: string) {
  const metaDir = path.join(folder, META_DIRNAME);
  return {
    assetsDir: path.join(folder, ASSETS_DIRNAME),
    exportsDir: path.join(folder, EXPORTS_DIRNAME),
    metaDir,
    storyPath: path.join(folder, STORY_FILENAME),
    versionPath: path.join(metaDir, VERSION_FILENAME),
    workflowPath: path.join(metaDir, WORKFLOW_FILENAME),
  };
}

export async function assertProjectFolder(folder: string): Promise<void> {
  const { versionPath } = projectPaths(folder);
  const version = (await fs.readFile(versionPath, "utf8")).trim();
  if (version !== FOLDER_FORMAT_VERSION) {
    throw new Error(`unsupported folder format version ${version}`);
  }
}

export async function createProject(raw: unknown): Promise<ProjectRecord> {
  const args = raw as CreateProjectArgs;
  const name = args.name?.trim();
  if (!name) throw new Error("project name required");
  if (!args.parent) throw new Error("project parent required");
  if (
    args.workflow_type &&
    args.workflow_state &&
    args.workflow_type !== args.workflow_state.type
  ) {
    throw new Error("workflow_type must match workflow_state.type");
  }

  const slug = slugify(name);
  if (!slug) throw new Error(`name ${JSON.stringify(name)} slugifies to empty string`);
  const folder = path.join(args.parent, slug);
  if (await pathExists(folder)) throw new Error(`project folder already exists: ${folder}`);

  const paths = projectPaths(folder);
  await fs.mkdir(paths.assetsDir, { recursive: true });
  await fs.mkdir(paths.exportsDir, { recursive: true });
  await fs.mkdir(paths.metaDir, { recursive: true });
  await fs.writeFile(paths.versionPath, FOLDER_FORMAT_VERSION, "utf8");
  await fs.writeFile(
    paths.storyPath,
    args.starter_story_source ?? defaultStarterStory(name),
    "utf8",
  );
  if (args.workflow_state) {
    await writeJson(paths.workflowPath, args.workflow_state);
  }

  const now = Date.now();
  const project: ProjectRecord = {
    id: randomUUID(),
    name,
    folder_path: folder,
    created_at: now,
    last_opened_at: now,
    thumbnail_path: null,
  };
  const projects = await readProjects();
  projects.unshift(project);
  await writeProjects(projects);
  return project;
}

export async function openProject(id: string) {
  const projects = await readProjects();
  const idx = projects.findIndex((candidate) => candidate.id === id);
  if (idx < 0) throw new Error(`project ${id} not found`);
  const project = { ...projects[idx], last_opened_at: Date.now() };
  projects[idx] = project;
  await assertProjectFolder(project.folder_path);
  await writeProjects(projects);
  const paths = projectPaths(project.folder_path);
  await fs.mkdir(paths.exportsDir, { recursive: true });
  const sessionCount = await countRecordingFiles(paths.exportsDir);
  return {
    id: project.id,
    name: project.name,
    folder_path: project.folder_path,
    story_path: paths.storyPath,
    exports_dir: paths.exportsDir,
    session_count: sessionCount,
  };
}

export async function countRecordingFiles(exportsDir: string): Promise<number> {
  return (await discoverProjectRecordings(exportsDir)).length;
}

export async function removeProject(id: string): Promise<void> {
  const projects = await readProjects();
  await writeProjects(projects.filter((project) => project.id !== id));
}

export async function getProjectWorkflow(id: string): Promise<WorkflowState | null> {
  const project = await findProject(id);
  return readJson<WorkflowState | null>(projectPaths(project.folder_path).workflowPath, null);
}

export async function updateProjectWorkflow(
  id: string,
  workflowState: WorkflowState,
): Promise<WorkflowState> {
  const project = await findProject(id);
  const next = { ...workflowState, updatedAt: Date.now() };
  await writeJson(projectPaths(project.folder_path).workflowPath, next);
  return next;
}

export async function listProjectRecordings(id: string) {
  const project = await findProject(id);
  const exportsDir = projectPaths(project.folder_path).exportsDir;
  await cleanupPartialRecordingBundles(exportsDir);
  await cleanupExpiredFailedRecordingBundles(exportsDir);
  return discoverProjectRecordings(exportsDir);
}

export async function timelineLoad(storyId: string): Promise<TimelineState | null> {
  return readJson<TimelineState | null>(timelinePath(storyId), null);
}

export async function timelineSave(storyId: string, layoutJson: string): Promise<void> {
  if (layoutJson.length > 1024 * 1024) {
    throw new Error(`layout_json is ${layoutJson.length} bytes; refusing > 1048576`);
  }
  await writeJson(timelinePath(storyId), {
    story_id: storyId,
    layout_json: layoutJson,
    last_modified: Date.now(),
  });
}

// @vitest-environment jsdom

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionTarget } from "./action-timeline";
import {
  executeFileUpload,
  FileUploadError,
  observeUploadInput,
  resolveUploadAsset,
} from "./file-upload";

const tempDirs: string[] = [];

async function projectFixture() {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-upload-"));
  tempDirs.push(project);
  await fs.mkdir(path.join(project, "assets"));
  const file = path.join(project, "assets", "sample.txt");
  await fs.writeFile(file, "hello upload");
  return { project, file, size: Buffer.byteLength("hello upload") };
}

function resolvedTarget(kind: "file_input" | "file_input_hidden" = "file_input"): ActionTarget {
  return {
    kind,
    label: "Upload file",
    center: { x: kind === "file_input" ? 120 : 0, y: kind === "file_input" ? 80 : 0 },
    bounds: { x: 100, y: 70, w: kind === "file_input" ? 40 : 0, h: kind === "file_input" ? 20 : 0 },
  };
}

function installFileInput(options: { hidden?: boolean; accept?: string } = {}) {
  document.body.innerHTML = `<input id="file" type="file" aria-label="Upload file" ${
    options.hidden ? 'style="display:none"' : ""
  } accept="${options.accept ?? ""}">`;
  const input = document.querySelector<HTMLInputElement>("#file");
  if (!input) throw new Error("fixture input missing");
  Object.defineProperty(input, "getBoundingClientRect", {
    value: () => ({
      x: options.hidden ? 0 : 100,
      y: options.hidden ? 0 : 70,
      left: options.hidden ? 0 : 100,
      top: options.hidden ? 0 : 70,
      right: options.hidden ? 0 : 140,
      bottom: options.hidden ? 0 : 90,
      width: options.hidden ? 0 : 40,
      height: options.hidden ? 0 : 20,
      toJSON: () => ({}),
    }),
  });
  return input;
}

function mockContents(input: {
  basename: string;
  byteSize: number;
  attached?: boolean;
  verify?: boolean;
  queryNodeId?: number;
}) {
  let attached = input.attached ?? false;
  const debuggerApi = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    sendCommand: vi.fn(async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: input.queryNodeId ?? 2 };
      if (method === "DOM.setFileInputFiles") {
        if (input.verify !== false) {
          const element = document.querySelector<HTMLInputElement>("#file");
          Object.defineProperty(element, "files", {
            configurable: true,
            value: [{ name: input.basename, size: input.byteSize }],
          });
        }
        return {};
      }
      throw new Error(`unexpected CDP method: ${method}`);
    }),
  };
  return {
    // biome-ignore lint/security/noGlobalEval: execute the generated renderer script in jsdom.
    executeJavaScript: vi.fn(async (script: string) => window.eval(script)),
    debugger: debuggerApi,
  };
}

describe("file upload", () => {
  beforeEach(() => {
    vi.stubEnv("STORYCAPTURE_UPLOAD_EXECUTION_MODE", "on");
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("resolves only readable regular files inside the canonical project root", async () => {
    const fixture = await projectFixture();
    const canonicalFile = await fs.realpath(fixture.file);
    await expect(resolveUploadAsset(fixture.project, "assets/sample.txt")).resolves.toMatchObject({
      absolutePath: canonicalFile,
      projectRelativePath: "assets/sample.txt",
      basename: "sample.txt",
      byteSize: fixture.size,
    });
    await expect(resolveUploadAsset(fixture.project, fixture.file)).rejects.toMatchObject({
      reason: "path_absolute",
    });
    await expect(resolveUploadAsset(fixture.project, "../outside.txt")).rejects.toMatchObject({
      reason: "path_outside_project",
    });
    await expect(resolveUploadAsset(fixture.project, "assets")).rejects.toMatchObject({
      reason: "path_not_regular",
    });
    await expect(resolveUploadAsset(fixture.project, "assets/missing.txt")).rejects.toMatchObject({
      reason: "path_missing",
    });
  });

  it("rejects a symlink that resolves outside the project", async () => {
    const fixture = await projectFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-upload-outside-"));
    tempDirs.push(outside);
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "secret");
    await fs.symlink(outsideFile, path.join(fixture.project, "assets", "escape.txt"));

    await expect(resolveUploadAsset(fixture.project, "assets/escape.txt")).rejects.toMatchObject({
      reason: "path_outside_project",
    });
  });

  it("accepts visible and intentionally hidden enabled file inputs", async () => {
    const visible = installFileInput();
    const visibleObservation = await observeUploadInput({
      // biome-ignore lint/security/noGlobalEval: execute the generated renderer script in jsdom.
      contents: { executeJavaScript: async (script: string) => window.eval(script) } as never,
      target: { kind: "selector", value: "#file" },
      selector: "#file",
      label: "Upload file",
    });
    expect(visibleObservation).toMatchObject({ status: "ready", target: { kind: "file_input" } });
    visible.remove();
    installFileInput({ hidden: true });
    await expect(
      observeUploadInput({
        // biome-ignore lint/security/noGlobalEval: execute the generated renderer script in jsdom.
        contents: { executeJavaScript: async (script: string) => window.eval(script) } as never,
        target: { kind: "selector", value: "#file" },
        selector: "#file",
        label: "Upload file",
      }),
    ).resolves.toMatchObject({ status: "ready", target: { kind: "file_input_hidden" } });
  });

  it("assigns and verifies one file without leaking the absolute path in its result", async () => {
    const fixture = await projectFixture();
    installFileInput({ accept: ".txt" });
    const asset = await resolveUploadAsset(fixture.project, "assets/sample.txt");
    const contents = mockContents({ basename: asset.basename, byteSize: asset.byteSize });
    const landmarks: string[] = [];

    const result = await executeFileUpload({
      contents,
      targetDescriptor: { kind: "selector", value: "#file" },
      selector: "#file",
      resolvedTarget: resolvedTarget(),
      asset,
      onInputSideEffect: (kind) => landmarks.push(kind),
    });

    expect(result).toEqual({
      target: resolvedTarget(),
      cursor: { x: 120, y: 80 },
      uploadAsset: {
        projectRelativePath: "assets/sample.txt",
        basename: "sample.txt",
        byteSize: fixture.size,
      },
    });
    expect(JSON.stringify(result)).not.toContain(fixture.project);
    expect(landmarks).toEqual(["action"]);
    expect(document.querySelector("#file")?.hasAttribute("data-storycapture-upload")).toBe(false);
    expect(contents.debugger.attach).toHaveBeenCalledOnce();
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
  });

  it("reuses an existing debugger attachment without detaching it", async () => {
    const fixture = await projectFixture();
    installFileInput();
    const asset = await resolveUploadAsset(fixture.project, "assets/sample.txt");
    const contents = mockContents({
      basename: asset.basename,
      byteSize: asset.byteSize,
      attached: true,
    });
    await executeFileUpload({
      contents,
      targetDescriptor: { kind: "selector", value: "#file" },
      selector: "#file",
      resolvedTarget: resolvedTarget(),
      asset,
    });
    expect(contents.debugger.attach).not.toHaveBeenCalled();
    expect(contents.debugger.detach).not.toHaveBeenCalled();
  });

  it("rejects accept mismatch before assignment and always cleans the marker", async () => {
    const fixture = await projectFixture();
    installFileInput({ accept: "image/*" });
    const asset = await resolveUploadAsset(fixture.project, "assets/sample.txt");
    const contents = mockContents({ basename: asset.basename, byteSize: asset.byteSize });
    await expect(
      executeFileUpload({
        contents,
        targetDescriptor: { kind: "selector", value: "#file" },
        selector: "#file",
        resolvedTarget: resolvedTarget(),
        asset,
      }),
    ).rejects.toMatchObject({ reason: "accept_mismatch", inputStarted: false });
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
    expect(document.querySelector("#file")?.hasAttribute("data-storycapture-upload")).toBe(false);
  });

  it("fails closed for detach, verification mismatch, and cancellation", async () => {
    const fixture = await projectFixture();
    const asset = await resolveUploadAsset(fixture.project, "assets/sample.txt");

    installFileInput();
    await expect(
      executeFileUpload({
        contents: mockContents({
          basename: asset.basename,
          byteSize: asset.byteSize,
          queryNodeId: 0,
        }),
        targetDescriptor: { kind: "selector", value: "#file" },
        selector: "#file",
        resolvedTarget: resolvedTarget(),
        asset,
      }),
    ).rejects.toMatchObject({ reason: "target_detached", inputStarted: false });

    installFileInput();
    await expect(
      executeFileUpload({
        contents: mockContents({
          basename: asset.basename,
          byteSize: asset.byteSize,
          verify: false,
        }),
        targetDescriptor: { kind: "selector", value: "#file" },
        selector: "#file",
        resolvedTarget: resolvedTarget(),
        asset,
      }),
    ).rejects.toMatchObject({ reason: "verification_failed", inputStarted: true });

    installFileInput();
    await expect(
      executeFileUpload({
        contents: mockContents({ basename: asset.basename, byteSize: asset.byteSize }),
        targetDescriptor: { kind: "selector", value: "#file" },
        selector: "#file",
        resolvedTarget: resolvedTarget(),
        asset,
        shouldCancel: () => true,
      }),
    ).rejects.toMatchObject({ reason: "cancelled_before_input", inputStarted: false });
  });

  it("keeps every public error message sanitized", () => {
    const error = new FileUploadError("path_outside_project", false, new Error("/secret/path"));
    expect(error.message).toBe("file_upload_failed:path_outside_project");
    expect(error.message).not.toContain("/secret/path");
  });
});

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ActionTarget } from "./action-timeline";
import type { InteractionObservation } from "./interaction-readiness";
import { simulatorTargetLookupHelpersScript } from "./simulator-dom";

export type UploadExecutionMode = "off" | "on";

export interface ResolvedUploadAsset {
  absolutePath: string;
  projectRelativePath: string;
  basename: string;
  byteSize: number;
}

export interface SafeUploadAsset {
  projectRelativePath: string;
  basename: string;
  byteSize: number;
}

export interface UploadExecutionResult {
  target: ActionTarget;
  cursor?: { x: number; y: number };
  uploadAsset: SafeUploadAsset;
}

export class FileUploadError extends Error {
  readonly recordingReasonCode: string;

  constructor(
    readonly reason:
      | "disabled"
      | "path_absolute"
      | "path_outside_project"
      | "path_missing"
      | "path_not_regular"
      | "path_unreadable"
      | "accept_mismatch"
      | "target_not_file_input"
      | "target_disabled"
      | "target_detached"
      | "cdp_unavailable"
      | "verification_failed"
      | "cancelled_before_input"
      | "cancelled_after_input",
    readonly inputStarted = false,
    cause?: unknown,
  ) {
    super(`file_upload_failed:${reason}`, cause === undefined ? undefined : { cause });
    this.name = "FileUploadError";
    this.recordingReasonCode = `upload_${reason}`;
  }
}

interface UploadWebContents {
  executeJavaScript(script: string): Promise<unknown>;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  };
}

export function uploadExecutionMode(
  value = process.env.STORYCAPTURE_UPLOAD_EXECUTION_MODE,
): UploadExecutionMode {
  return value === "on" || value === "1" ? "on" : "off";
}

export async function resolveUploadAsset(
  projectFolder: string,
  requestedPath: unknown,
): Promise<ResolvedUploadAsset> {
  const requested = typeof requestedPath === "string" ? requestedPath.trim() : "";
  if (!requested) throw new FileUploadError("path_missing");
  if (path.isAbsolute(requested)) throw new FileUploadError("path_absolute");

  let canonicalProject: string;
  let canonicalFile: string;
  try {
    canonicalProject = await fs.realpath(projectFolder);
  } catch (error) {
    throw new FileUploadError("path_missing", false, error);
  }
  const requestedAbsolutePath = path.resolve(canonicalProject, requested);
  const requestedRelativePath = path.relative(canonicalProject, requestedAbsolutePath);
  if (
    !requestedRelativePath ||
    requestedRelativePath.startsWith(`..${path.sep}`) ||
    requestedRelativePath === ".." ||
    path.isAbsolute(requestedRelativePath)
  ) {
    throw new FileUploadError("path_outside_project");
  }
  try {
    canonicalFile = await fs.realpath(requestedAbsolutePath);
  } catch (error) {
    throw new FileUploadError("path_missing", false, error);
  }
  const relative = path.relative(canonicalProject, canonicalFile);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new FileUploadError("path_outside_project");
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(canonicalFile);
  } catch (error) {
    throw new FileUploadError("path_missing", false, error);
  }
  if (!stat.isFile()) throw new FileUploadError("path_not_regular");
  try {
    await fs.access(canonicalFile, fs.constants.R_OK);
  } catch (error) {
    throw new FileUploadError("path_unreadable", false, error);
  }
  return {
    absolutePath: canonicalFile,
    projectRelativePath: relative.split(path.sep).join("/"),
    basename: path.basename(canonicalFile),
    byteSize: stat.size,
  };
}

function uploadTargetScript(input: {
  target: unknown;
  targetNth?: number;
  selector?: string | null;
  label?: string | null;
}): string {
  return `
    (() => {
      ${simulatorTargetLookupHelpersScript()}
      const el = findSimulatorTarget(
        ${JSON.stringify(input.target)},
        ${JSON.stringify(input.targetNth ?? null)},
        ${JSON.stringify(input.selector ?? null)}
      );
      if (!el) return { status: "not_ready", reason: "not_found" };
      if (!el.isConnected) return { status: "not_ready", reason: "detached" };
      if (!(el instanceof HTMLInputElement) || el.type !== "file") {
        return { status: "not_ready", reason: "not_file_input" };
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") {
        return { status: "not_ready", reason: "disabled" };
      }
      const rect = el.getBoundingClientRect();
      const visible = isVisible(el) && rect.width > 0 && rect.height > 0;
      return {
        status: "ready",
        target: {
          kind: visible ? "file_input" : "file_input_hidden",
          label: ${JSON.stringify(input.label ?? null)} || nameOf(el) || null,
          center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          bounds: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
        }
      };
    })()
  `;
}

export async function observeUploadInput(input: {
  contents: UploadWebContents;
  target: unknown;
  targetNth?: number;
  selector?: string | null;
  label?: string | null;
}): Promise<InteractionObservation> {
  return (await input.contents.executeJavaScript(
    uploadTargetScript(input),
  )) as InteractionObservation;
}

function acceptsAsset(accept: string, basename: string): boolean {
  const tokens = accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const extension = path.extname(basename).toLowerCase();
  const mimeByExtension: Record<string, string> = {
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
  };
  const mime = mimeByExtension[extension] ?? "application/octet-stream";
  return tokens.some(
    (token) =>
      token === extension ||
      token === mime ||
      (token.endsWith("/*") && mime.startsWith(token.slice(0, -1))),
  );
}

export async function executeFileUpload(input: {
  contents: UploadWebContents;
  targetDescriptor: unknown;
  targetNth?: number;
  selector?: string | null;
  resolvedTarget: ActionTarget;
  asset: ResolvedUploadAsset;
  shouldCancel?: () => boolean;
  beforeInputSideEffect?: () => void;
  onInputSideEffect?: (kind: "action") => void;
}): Promise<UploadExecutionResult> {
  if (uploadExecutionMode() === "off") throw new FileUploadError("disabled");
  if (input.shouldCancel?.()) throw new FileUploadError("cancelled_before_input");

  const attribute = "data-storycapture-upload";
  const token = randomUUID();
  const selector = `[${attribute}="${token}"]`;
  let ownsDebuggerAttachment = false;
  let assignmentStarted = false;
  const cleanupScript = `(() => { const el = document.querySelector(${JSON.stringify(
    selector,
  )}); if (el) el.removeAttribute(${JSON.stringify(attribute)}); })()`;

  try {
    const marked = (await input.contents.executeJavaScript(`
      (() => {
        ${simulatorTargetLookupHelpersScript()}
        const el = findSimulatorTarget(
          ${JSON.stringify(input.targetDescriptor)},
          ${JSON.stringify(input.targetNth ?? null)},
          ${JSON.stringify(input.selector ?? null)}
        );
        if (!el || !el.isConnected) return { ok: false, reason: "target_detached" };
        if (!(el instanceof HTMLInputElement) || el.type !== "file") {
          return { ok: false, reason: "target_not_file_input" };
        }
        if (el.disabled || el.getAttribute("aria-disabled") === "true") {
          return { ok: false, reason: "target_disabled" };
        }
        el.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(token)});
        return { ok: true, accept: el.accept || "" };
      })()
    `)) as { ok: boolean; reason?: FileUploadError["reason"]; accept?: string };
    if (!marked.ok) throw new FileUploadError(marked.reason ?? "target_detached");
    if (!acceptsAsset(marked.accept ?? "", input.asset.basename)) {
      throw new FileUploadError("accept_mismatch");
    }
    if (input.shouldCancel?.()) throw new FileUploadError("cancelled_before_input");

    try {
      if (!input.contents.debugger.isAttached()) {
        input.contents.debugger.attach("1.3");
        ownsDebuggerAttachment = true;
      }
      const documentResult = (await input.contents.debugger.sendCommand("DOM.getDocument", {
        depth: 0,
        pierce: true,
      })) as { root?: { nodeId?: number } };
      const rootNodeId = documentResult.root?.nodeId;
      if (!rootNodeId) throw new FileUploadError("cdp_unavailable");
      const queryResult = (await input.contents.debugger.sendCommand("DOM.querySelector", {
        nodeId: rootNodeId,
        selector,
      })) as { nodeId?: number };
      if (!queryResult.nodeId) throw new FileUploadError("target_detached");
      input.beforeInputSideEffect?.();
      assignmentStarted = true;
      await input.contents.debugger.sendCommand("DOM.setFileInputFiles", {
        files: [input.asset.absolutePath],
        nodeId: queryResult.nodeId,
      });
    } catch (error) {
      if (error instanceof FileUploadError) throw error;
      throw new FileUploadError("cdp_unavailable", assignmentStarted, error);
    }

    if (input.shouldCancel?.()) throw new FileUploadError("cancelled_after_input", true);
    const verified = (await input.contents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const file = el instanceof HTMLInputElement ? el.files?.[0] : null;
        return file ? { count: el.files.length, basename: file.name, byteSize: file.size } : null;
      })()
    `)) as { count: number; basename: string; byteSize: number } | null;
    if (
      !verified ||
      verified.count !== 1 ||
      verified.basename !== input.asset.basename ||
      verified.byteSize !== input.asset.byteSize
    ) {
      throw new FileUploadError("verification_failed", true);
    }
    input.onInputSideEffect?.("action");
    return {
      target: input.resolvedTarget,
      ...(input.resolvedTarget.kind === "file_input"
        ? { cursor: input.resolvedTarget.center }
        : {}),
      uploadAsset: {
        projectRelativePath: input.asset.projectRelativePath,
        basename: input.asset.basename,
        byteSize: input.asset.byteSize,
      },
    };
  } finally {
    await input.contents.executeJavaScript(cleanupScript).catch(() => {});
    if (ownsDebuggerAttachment) {
      try {
        input.contents.debugger.detach();
      } catch {
        // The command outcome remains authoritative; detach is best effort.
      }
    }
  }
}

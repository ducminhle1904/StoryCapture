import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { shell, type WebContents } from "electron";
import {
  deleteGenericSecret,
  loadOptionalGenericSecret,
  storeGenericSecret,
} from "../generic-secret-store";
import { readJson, writeJson } from "../json-store";
import { userDataPath } from "../paths";
import { assertRecordingV3UploadAllowed } from "../recording-v3-export-provenance";
import {
  type AudioInputInfo,
  channelIdFrom,
  type PendingOAuthFlow,
  sendChannel,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_MIN_MULTIPART_SIZE,
  type UploadProgressEvent,
  type UploadStatusDto,
  WEB_INFO_ACCOUNT,
  WEB_SECRET_SERVICE,
  WEB_TOKEN_ACCOUNT,
  type WebAccountInfo,
  type WebSyncQueueItem,
  type WebSyncStateFile,
  webBaseUrl,
  webSyncQueuePath,
  webSyncStatePath,
} from "./shared";

export let pendingOAuthFlow: PendingOAuthFlow | null = null;

export let uploadCancelRequested = false;

export let uploadStatus: UploadStatusDto = {
  status: "idle",
  progress: null,
  videoSlug: null,
  error: null,
};

export async function listAudioInputs(sender: WebContents): Promise<AudioInputInfo[]> {
  const devices = await sender
    .executeJavaScript(
      `(() => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
        return navigator.mediaDevices.enumerateDevices().then((devices) => {
          const seen = new Set();
          return devices
            .filter((device) => device.kind === "audioinput")
            .filter((device) => device.deviceId !== "default" && device.deviceId !== "communications")
            .filter((device) => {
              const id = device.deviceId || device.groupId || "";
              if (seen.has(id)) return false;
              seen.add(id);
              return true;
            })
            .map((device, index) => ({
              id: device.deviceId || device.groupId || ("audioinput-" + index),
              name: device.label || ("Microphone " + (index + 1)),
              is_default: index === 0,
              channels: 0,
              sample_rate_hz: 0,
            }));
        });
      })()`,
      true,
    )
    .catch(() => []);
  if (!Array.isArray(devices)) return [];
  return devices
    .filter((device): device is AudioInputInfo => {
      if (!device || typeof device !== "object") return false;
      const candidate = device as Partial<AudioInputInfo>;
      return typeof candidate.id === "string" && typeof candidate.name === "string";
    })
    .map((device, index) => ({
      id: device.id,
      name: device.name || `Microphone ${index + 1}`,
      is_default: Boolean(device.is_default),
      channels: Number.isFinite(device.channels) ? Number(device.channels) : 0,
      sample_rate_hz: Number.isFinite(device.sample_rate_hz) ? Number(device.sample_rate_hz) : 0,
    }));
}

export function secretStorePath(): string {
  return userDataPath("secrets.v1.json");
}

export async function getWebApiToken(): Promise<string | null> {
  return loadOptionalGenericSecret(WEB_SECRET_SERVICE, WEB_TOKEN_ACCOUNT);
}

export async function getWebAccount(): Promise<WebAccountInfo | null> {
  const json = await loadOptionalGenericSecret(WEB_SECRET_SERVICE, WEB_INFO_ACCOUNT);
  if (!json) return null;
  const parsed = JSON.parse(json) as Partial<WebAccountInfo>;
  if (typeof parsed.email !== "string") return null;
  return {
    email: parsed.email,
    name: parsed.name ?? null,
    avatarUrl: parsed.avatarUrl ?? null,
    connectedAt: parsed.connectedAt ?? new Date().toISOString(),
  };
}

export function closePendingOAuthFlow(): void {
  if (!pendingOAuthFlow) return;
  clearTimeout(pendingOAuthFlow.timer);
  pendingOAuthFlow.server.close();
  pendingOAuthFlow = null;
}

export async function startWebOauth(): Promise<number> {
  closePendingOAuthFlow();

  let resolveToken: (token: string) => void = () => {};
  let rejectToken: (error: Error) => void = () => {};
  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const token = requestUrl.searchParams.get("token");
    if (token) {
      response.writeHead(200, {
        "content-type": "text/html",
        connection: "close",
      });
      response.end(
        "<html><body><h1>Authentication successful</h1><p>You can close this window and return to StoryCapture.</p></body></html>",
      );
      resolveToken(token);
    } else {
      response.writeHead(400, {
        "content-type": "text/html",
        connection: "close",
      });
      response.end(
        "<html><body><h1>Authentication failed</h1><p>No token received. Please try again.</p></body></html>",
      );
      rejectToken(new Error("OAuth callback did not include a token"));
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind OAuth callback server"));
        return;
      }
      resolve(address.port);
    });
  });

  const timer = setTimeout(() => {
    rejectToken(new Error("OAuth flow timed out after 30 seconds"));
    closePendingOAuthFlow();
  }, 30_000);
  timer.unref?.();
  pendingOAuthFlow = {
    port,
    server,
    tokenPromise,
    resolveToken,
    rejectToken,
    timer,
  };

  try {
    await shell.openExternal(
      `${webBaseUrl()}/api/auth/signin/github?callbackUrl=http://localhost:${port}/callback`,
    );
  } catch (error) {
    closePendingOAuthFlow();
    throw error;
  }

  return port;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function completeWebOauth(): Promise<WebAccountInfo> {
  const flow = pendingOAuthFlow;
  if (!flow) throw new Error("no pending OAuth flow - call start_web_oauth first");

  let sessionToken: string;
  try {
    sessionToken = await flow.tokenPromise;
  } finally {
    closePendingOAuthFlow();
  }

  const response = await fetch(`${webBaseUrl()}/api/auth/desktop-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!response.ok) {
    throw new Error(`failed to exchange token: server returned ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const token = stringOrNull(body.token);
  const email = stringOrNull(body.email);
  if (!token || !email) throw new Error("failed to exchange token: invalid server response");

  const account: WebAccountInfo = {
    email,
    name: stringOrNull(body.name),
    avatarUrl: stringOrNull(body.avatarUrl ?? body.avatar_url),
    connectedAt: new Date().toISOString(),
  };
  await storeGenericSecret(WEB_SECRET_SERVICE, WEB_TOKEN_ACCOUNT, token);
  await storeGenericSecret(WEB_SECRET_SERVICE, WEB_INFO_ACCOUNT, JSON.stringify(account));
  return account;
}

export async function disconnectWebAccount(): Promise<null> {
  closePendingOAuthFlow();
  await deleteGenericSecret(WEB_SECRET_SERVICE, WEB_TOKEN_ACCOUNT);
  await deleteGenericSecret(WEB_SECRET_SERVICE, WEB_INFO_ACCOUNT);
  return null;
}

export async function readWebSyncQueue(): Promise<WebSyncQueueItem[]> {
  const queue = await readJson<WebSyncQueueItem[]>(webSyncQueuePath(), []);
  return Array.isArray(queue) ? queue : [];
}

export async function writeWebSyncQueue(queue: WebSyncQueueItem[]): Promise<void> {
  await writeJson(webSyncQueuePath(), queue);
}

export async function readWebSyncState(): Promise<WebSyncStateFile> {
  return readJson<WebSyncStateFile>(webSyncStatePath(), {
    version: 1,
    lastSync: null,
  });
}

export async function writeWebSyncState(update: Partial<WebSyncStateFile>): Promise<void> {
  const current = await readWebSyncState();
  await writeJson(webSyncStatePath(), { ...current, ...update, version: 1 });
}

export async function queueWebSyncItem(
  desktopId: string,
  workspaceId: string,
  payload: unknown,
): Promise<void> {
  const queue = await readWebSyncQueue();
  queue.push({
    id: randomUUID(),
    desktopId,
    workspaceId,
    payload,
    createdAt: new Date().toISOString(),
  });
  await writeWebSyncQueue(queue);
}

export async function postTrpcMutation(
  token: string,
  procedure: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${webBaseUrl()}/api/trpc/${procedure}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: payload }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "unknown");
    throw new Error(`${response.status}: ${body}`);
  }
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export function trpcLastSyncedAt(response: Record<string, unknown>): string {
  const result = response.result as { data?: { json?: { lastSyncedAt?: unknown } } } | undefined;
  return stringOrNull(result?.data?.json?.lastSyncedAt) ?? new Date().toISOString();
}

export function workflowStateFromJson(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") return null;
  return JSON.parse(value);
}

export function buildWebSyncPayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    desktopId: String(args.desktopId ?? ""),
    workspaceId: String(args.workspaceId ?? ""),
    projectName: String(args.projectName ?? ""),
    storySource: args.storySource ?? null,
    workflowType: args.workflowType ?? null,
    workflowState: workflowStateFromJson(args.workflowStateJson),
  };
}

export async function syncProjectMetadata(args: Record<string, unknown>) {
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");
  const desktopId = String(args.desktopId ?? "");
  const workspaceId = String(args.workspaceId ?? "");
  const payload = buildWebSyncPayload(args);
  try {
    const response = await postTrpcMutation(token, "sync.pushMetadata", payload);
    const lastSyncedAt = trpcLastSyncedAt(response);
    await writeWebSyncState({ lastSync: lastSyncedAt });
    return { synced: true, lastSyncedAt };
  } catch (error) {
    await queueWebSyncItem(desktopId, workspaceId, payload);
    throw error;
  }
}

export async function flushSyncQueue() {
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");

  const queue = await readWebSyncQueue();
  let flushed = 0;
  let failed = 0;
  const remaining: WebSyncQueueItem[] = [];
  for (const item of queue) {
    try {
      await postTrpcMutation(token, "sync.pushMetadata", item.payload);
      flushed += 1;
    } catch {
      failed += 1;
      remaining.push(item);
    }
  }
  await writeWebSyncQueue(remaining);
  if (flushed > 0) await writeWebSyncState({ lastSync: new Date().toISOString() });
  return { flushed, failed, remaining: remaining.length };
}

export async function getSyncStatus() {
  const [token, queue, state] = await Promise.all([
    getWebApiToken(),
    readWebSyncQueue(),
    readWebSyncState(),
  ]);
  return {
    connected: token != null,
    pendingCount: queue.length,
    lastSync: state.lastSync,
  };
}

export async function updateRecordingStatus(args: Record<string, unknown>): Promise<null> {
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");
  await postTrpcMutation(token, "sync.updateRecordingStatus", {
    desktopId: String(args.desktopId ?? ""),
    workspaceId: String(args.workspaceId ?? ""),
    status: String(args.status ?? ""),
  });
  return null;
}

export function updateUploadStatus(
  progress: UploadProgressEvent | null,
  sender?: WebContents,
  channelId?: number | null,
): void {
  uploadStatus = { ...uploadStatus, progress };
  if (progress && sender) sendChannel(sender, channelId ?? null, progress);
}

export async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

export async function uploadVideo(args: Record<string, unknown>, sender: WebContents) {
  const videoPath = String(args.videoPath ?? "");
  await assertRecordingV3UploadAllowed(videoPath, args.recordingMode);
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");

  const projectName = String(args.projectName ?? "Untitled project");
  const workspaceId = stringOrNull(args.workspaceId) ?? "personal";
  const onProgress = channelIdFrom(args.onProgress);
  const fileName = path.basename(videoPath);
  const stat = await fs.stat(videoPath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`file not found: ${videoPath}`);
  if (stat.size <= 0) throw new Error("file is empty");

  uploadCancelRequested = false;
  uploadStatus = {
    status: "uploading",
    progress: null,
    videoSlug: null,
    error: null,
  };
  const totalBytes = stat.size;
  updateUploadStatus(
    {
      phase: "thumbnail",
      partNumber: 0,
      totalParts: 0,
      bytesUploaded: 0,
      totalBytes,
    },
    sender,
    onProgress,
  );

  const body: Record<string, unknown> = {
    fileName,
    fileSizeBytes: totalBytes,
    contentType: "video/mp4",
    workspaceId,
    projectName,
  };
  if (typeof args.storySource === "string") body.storySource = args.storySource;
  if (typeof args.sceneBoundaries === "string")
    body.sceneBoundaries = JSON.parse(args.sceneBoundaries);

  const initiate = await fetch(`${webBaseUrl()}/api/upload/initiate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!initiate.ok)
    throw new Error(`initiate failed: ${initiate.status} - ${await initiate.text()}`);
  const init = await parseJsonResponse(initiate);
  const videoId = stringOrNull(init.videoId);
  const uploadId = stringOrNull(init.uploadId);
  const r2Key = stringOrNull(init.r2Key);
  const slug = stringOrNull(init.slug);
  if (!videoId || !uploadId || !r2Key || !slug)
    throw new Error("initiate failed: invalid server response");

  const totalParts =
    totalBytes < UPLOAD_MIN_MULTIPART_SIZE ? 1 : Math.ceil(totalBytes / UPLOAD_CHUNK_SIZE);
  const parts: Array<{ PartNumber: number; ETag: string }> = [];
  let bytesUploaded = 0;
  const file = await fs.open(videoPath, "r");
  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      if (uploadCancelRequested) throw new Error("upload cancelled");
      const remaining = totalBytes - bytesUploaded;
      const chunkLength = Math.min(UPLOAD_CHUNK_SIZE, remaining);
      const chunk = Buffer.alloc(chunkLength);
      const { bytesRead } = await file.read(chunk, 0, chunkLength, bytesUploaded);
      const payload = chunk.subarray(0, bytesRead);

      const presign = await fetch(`${webBaseUrl()}/api/upload/presign`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ r2Key, uploadId, partNumber }),
      });
      if (!presign.ok)
        throw new Error(`presign failed for part ${partNumber}: ${await presign.text()}`);
      const presignBody = await parseJsonResponse(presign);
      const presignedUrl = stringOrNull(presignBody.presignedUrl ?? presignBody.presigned_url);
      if (!presignedUrl) throw new Error(`presign failed for part ${partNumber}: missing URL`);

      const put = await fetch(presignedUrl, {
        method: "PUT",
        body: payload as unknown as BodyInit,
      });
      if (!put.ok) throw new Error(`PUT part ${partNumber} failed: ${await put.text()}`);
      parts.push({
        PartNumber: partNumber,
        ETag: put.headers.get("etag") ?? "",
      });
      bytesUploaded += bytesRead;
      updateUploadStatus(
        {
          phase: "uploading",
          partNumber,
          totalParts,
          bytesUploaded,
          totalBytes,
        },
        sender,
        onProgress,
      );
    }
  } finally {
    await file.close();
  }

  if (uploadCancelRequested) throw new Error("upload cancelled");
  updateUploadStatus(
    {
      phase: "completing",
      partNumber: totalParts,
      totalParts,
      bytesUploaded: totalBytes,
      totalBytes,
    },
    sender,
    onProgress,
  );

  const complete = await fetch(`${webBaseUrl()}/api/upload/complete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      videoId,
      r2Key,
      uploadId,
      parts,
      thumbnailR2Key: r2Key.replace(/\.[^.]+$/, "-thumb.jpg"),
    }),
  });
  if (!complete.ok) throw new Error(`complete failed: ${await complete.text()}`);
  const result = await parseJsonResponse(complete);
  const uploadResult = {
    videoId: stringOrNull(result.videoId) ?? videoId,
    slug: stringOrNull(result.slug) ?? slug,
    status: stringOrNull(result.status) ?? "ready",
  };
  uploadStatus = {
    status: "complete",
    progress: null,
    videoSlug: uploadResult.slug,
    error: null,
  };
  return uploadResult;
}

export async function uploadVideoWithStatus(args: Record<string, unknown>, sender: WebContents) {
  try {
    return await uploadVideo(args, sender);
  } catch (error) {
    uploadStatus = {
      status: "error",
      progress: null,
      videoSlug: null,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

export function cancelUpload(): null {
  uploadCancelRequested = true;
  return null;
}

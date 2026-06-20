import { startAuthorPreview, stopAuthorPreview } from "@/ipc/preview";
import { frontendLog } from "@/lib/log";

export interface RecordingPreviewViewport {
  width: number;
  height: number;
}

export interface RecordingPreviewLease {
  streamId: string;
  release: () => void;
}

export interface AcquireRecordingPreviewArgs {
  appUrl: string;
  viewport: RecordingPreviewViewport;
  reason: string;
  fps: number;
  timeoutMs?: number;
}

function recordingPartition(): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `recording-${id}`;
}

export async function acquireRecordingPreview({
  appUrl,
  viewport,
  reason,
  fps,
  timeoutMs = 8_000,
}: AcquireRecordingPreviewArgs): Promise<RecordingPreviewLease> {
  const partition = recordingPartition();
  let timedOut = false;
  const startPromise = startAuthorPreview({
    initialUrl: appUrl,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    fps,
    replaceExisting: false,
    partition,
    purpose: "recording",
  }).then(
    (streamId) => {
      if (timedOut) {
        void stopAuthorPreview(streamId).catch((err) => {
          frontendLog.warn("RecordingView", "stop timed-out recording preview failed", {
            error: err,
            fields: { reason, stream_id: streamId },
          });
        });
      }
      return streamId;
    },
    (err) => {
      if (timedOut) {
        frontendLog.warn("RecordingView", "timed-out recording preview start failed", {
          error: err,
          fields: { reason, partition },
        });
        return "";
      }
      throw err;
    },
  );
  let timer: number | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      timedOut = true;
      reject(new Error("Timed out waiting for recording browser preview"));
    }, timeoutMs);
  });
  const streamId = await Promise.race([startPromise, timeoutPromise]).finally(() => {
    if (timer != null) window.clearTimeout(timer);
  });
  if (!streamId) throw new Error("Timed out waiting for recording browser preview");
  frontendLog.info("RecordingView", "acquired isolated recording preview", {
    fields: { reason, stream_id: streamId, partition },
  });

  let released = false;
  return {
    streamId,
    release: () => {
      if (released) return;
      released = true;
      void stopAuthorPreview(streamId).catch((err) => {
        frontendLog.warn("RecordingView", "stop recording preview failed", {
          error: err,
          fields: { reason, stream_id: streamId },
        });
      });
      frontendLog.info("RecordingView", "released isolated recording preview", {
        fields: { reason, stream_id: streamId },
      });
    },
  };
}

/**
 * Static 2s-refresh preview thumbnail of the selected capture target.
 *
 * Contract:
 *   - Refetches every 2s; pauses when recording or target is null (no
 *     cycles stolen from the real capture pipeline).
 *   - On error (TCC denied, window closed, IPC failure) renders a
 *     neutral placeholder instead of surfacing an error state.
 *   - Revokes the previous object URL on target change AND unmount
 *     (threat-model mitigation T-06-20: no leaked Blob references).
 *   - `gcTime: 0` — no thumbnail bytes survive past the active refetch
 *     cycle (T-06-21: minimize in-memory image residency).
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageOff } from "lucide-react";

import {
  captureTargetKey,
  captureTargetThumbnail,
  type CaptureTarget,
} from "@/ipc/capture";

export interface TargetThumbnailProps {
  target: CaptureTarget | null;
  /** When true, suspend refetching (e.g. during active recording). */
  paused?: boolean;
  /** Override the default 320×200 bounds (HiDPI previews). */
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
}

/**
 * Render the live-preview thumbnail. Memoizes the queryKey on the
 * stable `captureTargetKey` string so target changes invalidate cleanly.
 */
export function TargetThumbnail({
  target,
  paused = false,
  maxWidth = 320,
  maxHeight = 200,
  className,
}: TargetThumbnailProps): JSX.Element {
  const key = target ? captureTargetKey(target) : "none";
  const enabled = target != null && !paused;

  const query = useQuery<Uint8Array, Error>({
    queryKey: ["target-thumbnail", key, maxWidth, maxHeight],
    queryFn: async () => {
      if (!target) throw new Error("no target");
      const bytes = await captureTargetThumbnail(target, maxWidth, maxHeight);
      // specta emits number[]; marshal into Uint8Array for Blob.
      return Uint8Array.from(bytes);
    },
    enabled,
    refetchInterval: enabled ? 2000 : false,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });

  // Convert PNG bytes → object URL; revoke the previous on data/target
  // change + on unmount (T-06-20). `useMemo` recomputes on data change,
  // `useEffect` cleanup fires with the *previous* url value.
  const objectUrl = useMemo<string | null>(() => {
    if (!query.data) return null;
    return URL.createObjectURL(
      new Blob([query.data as unknown as BlobPart], { type: "image/png" }),
    );
  }, [query.data]);

  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    // Revoke whatever we had before.
    if (urlRef.current && urlRef.current !== objectUrl) {
      URL.revokeObjectURL(urlRef.current);
    }
    urlRef.current = objectUrl;
    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [objectUrl]);

  const isPlaceholder = !target || query.isError || !objectUrl;

  return (
    <div
      data-testid="target-thumbnail"
      className={
        className ??
        "flex items-center justify-center overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)]"
      }
      style={{ width: maxWidth, height: maxHeight }}
      aria-label="Capture target preview"
    >
      {isPlaceholder ? (
        <div
          data-testid="target-thumbnail-placeholder"
          className="flex flex-col items-center gap-1 text-[10px] text-[var(--color-fg-muted)]"
        >
          <ImageOff size={18} aria-hidden="true" />
          <span>
            {!target
              ? "No target selected"
              : paused
                ? "Paused during recording"
                : "Preview unavailable"}
          </span>
        </div>
      ) : (
        <img
          data-testid="target-thumbnail-image"
          src={objectUrl ?? ""}
          alt=""
          className="h-full w-full object-contain"
          draggable={false}
        />
      )}
    </div>
  );
}

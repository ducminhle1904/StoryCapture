/**
 * ClipAffordance — wraps a generic <Track> for the cursor / zoom /
 * annotations rows, adding two adapter-level UX affordances WITHOUT
 * touching the shared Track component:
 *
 *   1. A right-click context menu per clip ("Properties" + "Delete")
 *      rendered with Astryx ContextMenu. Pointer-down events (drag) still
 *      flow through to the underlying Track unimpeded.
 *
 * Sound + Video tracks intentionally stay as thin Track wrappers — these
 * affordances are scoped to the three layers the user requested.
 */

import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { useCallback, useMemo, useState } from "react";

import { useEditorStore } from "../state/store";
import type { Clip, TrackId } from "../state/timeline-slice";
import { Track } from "../timeline/track";

export interface ClipAffordanceProps {
  id: Extract<TrackId, "cursor" | "zoom" | "annotations">;
  clips: readonly Clip[];
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function ClipAffordance({
  id,
  clips,
  pxPerMs,
  durationMs,
  height = 40,
}: ClipAffordanceProps) {
  const [contextClipId, setContextClipId] = useState<string | null>(null);

  const pushAction = useEditorStore((s) => s.pushAction);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);

  // Resolve clipId from the right-click target's data attribute. If the
  // user right-clicks on empty track space we no-op and let the browser
  // show its default menu.
  const prepareContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-id]");
    if (!target) {
      event.stopPropagation();
      return;
    }
    const clipId = target.dataset.clipId ?? null;
    if (!clipId) {
      event.stopPropagation();
      return;
    }
    setContextClipId(clipId);
  }, []);

  const onOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) setContextClipId(null);
  }, []);

  const targetClip = useMemo(
    () => (contextClipId ? (clips.find((clip) => clip.id === contextClipId) ?? null) : null),
    [clips, contextClipId],
  );

  const onProperties = useCallback(() => {
    if (!contextClipId) return;
    setSelectedClipId(contextClipId);
    setSelectedTab("effects");
    setContextClipId(null);
  }, [contextClipId, setSelectedClipId, setSelectedTab]);

  const onDelete = useCallback(() => {
    if (!targetClip) return;
    const idx = clips.findIndex((c) => c.id === targetClip.id);
    pushAction({
      kind: "delete-clip",
      trackId: id,
      clipId: targetClip.id,
      snapshot: targetClip,
      atIndex: idx >= 0 ? idx : undefined,
    });
    setContextClipId(null);
  }, [clips, id, pushAction, targetClip]);

  return (
    <ContextMenu
      label="Clip actions"
      menuWidth={160}
      onOpenChange={onOpenChange}
      items={[
        { label: "Properties", onClick: onProperties },
        { label: "Delete", onClick: onDelete },
      ]}
    >
      <fieldset
        className="relative m-0 min-w-0 border-0 p-0"
        aria-label={`${id} track actions`}
        onContextMenuCapture={prepareContextMenu}
      >
        <Track id={id} clips={clips} pxPerMs={pxPerMs} durationMs={durationMs} height={height} />
      </fieldset>
    </ContextMenu>
  );
}

/**
 * ClipAffordance — wraps a generic <Track> for the cursor / zoom /
 * annotations rows, adding two adapter-level UX affordances WITHOUT
 * touching the shared Track component:
 *
 *   1. A right-click context menu per clip ("Properties" + "Delete")
 *      rendered with Base UI's `Menu`, anchored at the cursor via a
 *      VirtualElement. Pointer-down events (drag) still flow through to
 *      the underlying Track unimpeded.
 *
 * Sound + Video tracks intentionally stay as thin Track wrappers — these
 * affordances are scoped to the three layers the user requested.
 */

import { Menu } from "@base-ui/react/menu";
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

interface MenuState {
  open: boolean;
  clipId: string | null;
  /** Viewport coords used to build a VirtualElement for the positioner. */
  x: number;
  y: number;
}

const CLOSED: MenuState = { open: false, clipId: null, x: 0, y: 0 };

export function ClipAffordance({
  id,
  clips,
  pxPerMs,
  durationMs,
  height = 40,
}: ClipAffordanceProps) {
  const [menu, setMenu] = useState<MenuState>(CLOSED);

  const pushAction = useEditorStore((s) => s.pushAction);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);

  // Resolve clipId from the right-click target's data attribute. If the
  // user right-clicks on empty track space we no-op and let the browser
  // show its default menu.
  const onContextMenu = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-clip-id]");
    if (!target) return;
    const clipId = target.dataset.clipId ?? null;
    if (!clipId) return;
    e.preventDefault();
    setMenu({ open: true, clipId, x: e.clientX, y: e.clientY });
  }, []);

  const onOpenChange = useCallback((next: boolean) => {
    if (!next) setMenu(CLOSED);
  }, []);

  // Virtual anchor at the cursor position. Must be a stable reference
  // for the open lifecycle so floating-ui doesn't re-measure each frame.
  const virtualAnchor = useMemo(() => {
    const { x, y } = menu;
    return {
      getBoundingClientRect: () => ({
        x,
        y,
        left: x,
        top: y,
        right: x,
        bottom: y,
        width: 0,
        height: 0,
        toJSON: () => ({ x, y, left: x, top: y, right: x, bottom: y }),
      }),
    };
  }, [menu]);

  const targetClip = useMemo(
    () => (menu.clipId ? (clips.find((c) => c.id === menu.clipId) ?? null) : null),
    [clips, menu.clipId],
  );

  const onProperties = useCallback(() => {
    if (!menu.clipId) return;
    setSelectedClipId(menu.clipId);
    setSelectedTab("effects");
    setMenu(CLOSED);
  }, [menu.clipId, setSelectedClipId, setSelectedTab]);

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
    setMenu(CLOSED);
  }, [clips, id, pushAction, targetClip]);

  return (
    <fieldset
      className="relative m-0 min-w-0 border-0 p-0"
      aria-label={`${id} track actions`}
      onContextMenu={onContextMenu}
    >
      <Track id={id} clips={clips} pxPerMs={pxPerMs} durationMs={durationMs} height={height} />

      <Menu.Root open={menu.open} onOpenChange={onOpenChange} modal={false}>
        <Menu.Portal>
          <Menu.Positioner anchor={virtualAnchor} sideOffset={4}>
            <Menu.Popup
              className="z-50 min-w-[160px] rounded-md border border-[var(--sc-border,var(--color-border))] bg-[var(--sc-surface-200,var(--color-surface))] p-1 text-sm text-[var(--sc-fg,var(--color-fg))] shadow-lg outline-none"
              role="menu"
              aria-label={`Clip actions`}
            >
              <Menu.Item
                className="flex cursor-pointer items-center rounded px-3 py-1.5 text-[var(--sc-fg,var(--color-fg))] outline-none data-[highlighted]:bg-[var(--sc-surface-300,var(--color-surface-hi))]"
                onClick={onProperties}
              >
                Properties
              </Menu.Item>
              <Menu.Item
                className="flex cursor-pointer items-center rounded px-3 py-1.5 text-[var(--sc-fg,var(--color-fg))] outline-none data-[highlighted]:bg-[var(--sc-surface-300,var(--color-surface-hi))]"
                onClick={onDelete}
              >
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </fieldset>
  );
}

/**
 * SoundDrawer — left-side slide-out browser of SFX + BGM entries. Lists
 * are fetched via `soundLibraryList` (TanStack Query); the drawer
 * renders two category tabs and a scrollable list of `SoundRow`s.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";

import {
  soundLibraryList,
  SOUND_LIBRARY_KEYS,
  type SoundCategory,
} from "@/ipc/sound-library";
import { useEditorStore } from "../state/store";
import { SoundRow } from "./sound-row";

const CATEGORIES: Array<{ id: SoundCategory; label: string }> = [
  { id: "sfx", label: "SFX" },
  { id: "bgm", label: "Music" },
];

export function SoundDrawer() {
  const open = useEditorStore((s) => s.soundDrawerOpen);
  const setOpen = useEditorStore((s) => s.setSoundDrawerOpen);
  const [cat, setCat] = useState<SoundCategory>("sfx");

  const query = useQuery({
    queryKey: SOUND_LIBRARY_KEYS.list(cat),
    queryFn: () => soundLibraryList(cat),
    enabled: open,
  });

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-[var(--color-fg-primary)/40]"
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Sound library"
        className="fixed inset-y-0 left-0 z-40 flex w-96 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            Sound library
          </h2>
          <button
            type="button"
            aria-label="Close sound library"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div
          role="tablist"
          aria-label="Sound categories"
          className="flex shrink-0 border-b border-[var(--color-border)]"
        >
          {CATEGORIES.map((c) => {
            const active = c.id === cat;
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`flex-1 px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                  active
                    ? "border-b-2 border-[var(--color-accent,#ff5b76)] text-[var(--color-fg)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                }`}
                onClick={() => setCat(c.id)}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <div
          role="list"
          aria-label={`${cat.toUpperCase()} entries`}
          className="flex-1 space-y-2 overflow-auto p-3"
        >
          {query.isLoading ? (
            <div role="status" className="text-sm text-[var(--color-fg-muted)]">
              Loading…
            </div>
          ) : query.isError ? (
            <div role="alert" className="text-sm text-red-400">
              Failed: {String(query.error)}
            </div>
          ) : (query.data ?? []).length === 0 ? (
            <div className="text-sm text-[var(--color-fg-muted)]">
              No entries in this category yet.
            </div>
          ) : (
            (query.data ?? []).map((entry) => (
              <SoundRow key={entry.id} entry={entry} />
            ))
          )}
        </div>
      </aside>
    </>
  );
}

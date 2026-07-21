/**
 * SoundDrawer — left-side slide-out browser of SFX + BGM entries. Lists
 * are fetched via `soundLibraryList` (TanStack Query); the drawer
 * renders two category tabs and a scrollable list of `SoundRow`s.
 */

import { Button } from "@astryxdesign/core/Button";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";

import { SOUND_LIBRARY_KEYS, type SoundCategory, soundLibraryList } from "@/ipc/sound-library";
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
        className="fixed inset-0 z-30 bg-[var(--color-text-primary)/40]"
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Sound library"
        className="fixed inset-y-0 left-0 z-40 flex w-96 flex-col border-r border-[var(--color-border)] bg-[var(--color-background-body)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Sound library</h2>
          <Button
            label="Close sound library"
            variant="ghost"
            size="sm"
            isIconOnly
            icon={<X className="h-4 w-4" />}
            onClick={() => setOpen(false)}
          />
        </header>
        <TabList
          aria-label="Sound categories"
          value={cat}
          onChange={(value) => setCat(value as SoundCategory)}
          layout="fill"
          hasDivider
          size="sm"
          className="shrink-0"
        >
          {CATEGORIES.map((category) => (
            <Tab key={category.id} value={category.id} label={category.label} />
          ))}
        </TabList>
        <ul
          aria-label={`${cat.toUpperCase()} entries`}
          className="flex-1 space-y-2 overflow-auto p-3"
        >
          {query.isLoading ? (
            <div role="status" className="text-sm text-[var(--color-text-secondary)]">
              Loading…
            </div>
          ) : query.isError ? (
            <div role="alert" className="text-sm text-red-400">
              Failed: {String(query.error)}
            </div>
          ) : (query.data ?? []).length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)]">
              No entries in this category yet.
            </div>
          ) : (
            (query.data ?? []).map((entry) => <SoundRow key={entry.id} entry={entry} />)
          )}
        </ul>
      </aside>
    </>
  );
}

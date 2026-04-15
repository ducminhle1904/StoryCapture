/**
 * PresetPicker — grid of bundled + user effect presets (Plan 02-12b).
 *
 * Reads from Plan 02-12a's `presetList({ scope })` via TanStack Query.
 * Selecting a card writes `selectedPresetId` to the store; application
 * of the preset graph to the current project lives in P13 (history +
 * undo-able dispatch) — here we just flag the selection.
 */

import { memo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  presetList,
  PRESET_KEYS,
  type EffectPreset,
  type PresetScope,
} from "@/ipc/presets";
import { useEditorStore } from "../state/store";

export interface PresetPickerProps {
  scope?: PresetScope;
}

function PresetCard({ preset }: { preset: EffectPreset }) {
  const selectedPresetId = useEditorStore((s) => s.selectedPresetId);
  const setSelectedPresetId = useEditorStore((s) => s.setSelectedPresetId);
  const selected = selectedPresetId === preset.id;

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Apply preset ${preset.name}`}
      onClick={() => setSelectedPresetId(preset.id)}
      className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
        selected
          ? "border-[var(--color-accent,#ff5b76)] bg-[var(--color-surface-hi)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-fg-muted)]"
      }`}
    >
      <span className="text-sm font-medium text-[var(--color-fg)]">{preset.name}</span>
      {preset.description ? (
        <span className="line-clamp-2 text-xs text-[var(--color-fg-muted)]">
          {preset.description}
        </span>
      ) : null}
      <span className="mt-1 text-[10px] uppercase tracking-wide text-[var(--color-fg-muted)]">
        {preset.scope}
        {preset.bundled ? " • bundled" : ""}
      </span>
    </button>
  );
}

function PresetPickerBase({ scope = "project" }: PresetPickerProps) {
  const query = useQuery({
    queryKey: PRESET_KEYS.list(scope),
    queryFn: () => presetList(scope),
  });

  if (query.isLoading) {
    return (
      <div role="status" className="p-4 text-sm text-[var(--color-fg-muted)]">
        Loading presets…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert" className="p-4 text-sm text-red-400">
        Failed to load presets: {String(query.error)}
      </div>
    );
  }
  const items = query.data ?? [];
  if (items.length === 0) {
    return (
      <div className="p-4 text-sm text-[var(--color-fg-muted)]">
        No presets yet. Import one to get started.
      </div>
    );
  }
  return (
    <div
      role="list"
      aria-label={`Effect presets (${scope})`}
      className="grid grid-cols-2 gap-2 p-3"
    >
      {items.map((p) => (
        <div role="listitem" key={p.id}>
          <PresetCard preset={p} />
        </div>
      ))}
    </div>
  );
}

export const PresetPicker = memo(PresetPickerBase);

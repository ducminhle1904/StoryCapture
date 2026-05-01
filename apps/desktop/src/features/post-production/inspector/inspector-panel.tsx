/**
 * InspectorPanel — tabbed side panel: Presets | Effects | Sound. Built
 * with a thin button-group + conditional render rather than a heavy Tabs
 * primitive; keyboard navigation works out of the box with native
 * buttons + Tab.
 */

import { Layers3, Music2, Palette, SlidersHorizontal } from "lucide-react";
import type { ComponentType } from "react";
import { useMemo } from "react";

import type { InspectorTab } from "../state/selection-slice";
import { useEditorStore } from "../state/store";
import { BackgroundPanel } from "./background-panel";
import { EffectParams } from "./effect-params";
import { PresetPicker } from "./preset-picker";

const TABS: Array<{
  id: InspectorTab;
  label: string;
  short: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: "true" }>;
}> = [
  { id: "presets", label: "Presets", short: "PRE", icon: Layers3 },
  { id: "effects", label: "Effects", short: "FX", icon: SlidersHorizontal },
  { id: "background", label: "Background", short: "BG", icon: Palette },
  { id: "sound", label: "Sound", short: "SND", icon: Music2 },
];

export function InspectorPanel() {
  const selectedTab = useEditorStore((s) => s.selectedTab);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);
  const setSoundDrawerOpen = useEditorStore((s) => s.setSoundDrawerOpen);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const activeTab = TABS.find((tab) => tab.id === selectedTab) ?? TABS[0];

  const body = useMemo(() => {
    switch (selectedTab) {
      case "presets":
        return <PresetPicker scope="project" />;
      case "effects":
        return <EffectParams />;
      case "background":
        return <BackgroundPanel />;
      case "sound":
        return (
          <div className="p-3 text-sm text-[var(--sc-text-3)]">
            <p className="mb-3 text-xs leading-5">
              Add cues and background music from the library.
            </p>
            <button
              type="button"
              className="w-full rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-3 py-2 text-xs font-medium text-[var(--sc-text)] transition-[background-color,transform] hover:bg-[var(--sc-surface-2)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sc-focus-ring)]"
              onClick={() => setSoundDrawerOpen(true)}
            >
              Open Sound Library
            </button>
          </div>
        );
    }
  }, [selectedTab, setSoundDrawerOpen]);

  return (
    <aside
      aria-label="Inspector"
      className="grid h-full w-full grid-cols-[52px_minmax(0,1fr)] bg-transparent"
    >
      <div
        role="tablist"
        aria-label="Inspector sections"
        className="flex flex-col items-center gap-1 border-r border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-1.5 py-2"
      >
        {TABS.map((t) => {
          const active = t.id === selectedTab;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`inspector-panel-${t.id}`}
              id={`inspector-tab-${t.id}`}
              tabIndex={active ? 0 : -1}
              title={t.label}
              className={`flex h-11 w-10 flex-col items-center justify-center gap-0.5 rounded-[var(--sc-r-md)] text-[9px] font-semibold uppercase tracking-[0.08em] transition-[background-color,color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sc-focus-ring)] active:scale-[0.96] ${
                active
                  ? "bg-[var(--sc-surface)] text-[var(--sc-text)] shadow-[inset_0_0_0_1px_var(--sc-border)]"
                  : "text-[var(--sc-text-4)] hover:bg-[var(--sc-surface)] hover:text-[var(--sc-text-2)]"
              }`}
              onClick={() => setSelectedTab(t.id)}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{t.short}</span>
            </button>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--sc-border)] px-3">
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold text-[var(--sc-text)]">
              {activeTab.label}
            </div>
            <div className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
              {selectedClipId ? "Clip Selected" : "No Clip"}
            </div>
          </div>
        </div>
        <div
          role="tabpanel"
          id={`inspector-panel-${selectedTab}`}
          aria-labelledby={`inspector-tab-${selectedTab}`}
          className="min-h-0 flex-1 overflow-auto px-1 py-1"
        >
          {body}
        </div>
      </div>
    </aside>
  );
}

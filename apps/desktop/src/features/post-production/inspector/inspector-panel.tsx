/**
 * InspectorPanel — Astryx-tabbed side panel: Presets | Effects | Sound.
 * Content remains product-owned while TabList supplies roving focus and
 * keyboard navigation.
 */

import { Button } from "@astryxdesign/core/Button";
import { Tab, TabList } from "@astryxdesign/core/TabList";
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
          <div className="p-3 text-sm text-[var(--color-text-secondary)]">
            <p className="mb-3 text-xs leading-5">
              Add cues and background music from the library.
            </p>
            <Button
              label="Open Sound Library"
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => setSoundDrawerOpen(true)}
            />
          </div>
        );
    }
  }, [selectedTab, setSoundDrawerOpen]);

  return (
    <aside
      aria-label="Inspector"
      className="grid h-full min-h-0 w-full grid-cols-[52px_minmax(0,1fr)] bg-transparent"
    >
      <TabList
        aria-label="Inspector sections"
        value={selectedTab}
        onChange={(value) => setSelectedTab(value as InspectorTab)}
        orientation="vertical"
        size="sm"
        className="flex flex-col items-center gap-1 border-r border-[var(--color-border)] bg-[var(--color-background-card)] px-1.5 py-2"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <Tab
              key={t.id}
              value={t.id}
              label={t.label}
              isLabelHidden
              icon={
                <span className="flex flex-col items-center gap-0.5">
                  <Icon size={14} aria-hidden="true" />
                  <span aria-hidden="true">{t.short}</span>
                </span>
              }
              aria-controls={`inspector-panel-${t.id}`}
              id={`inspector-tab-${t.id}`}
              className="h-11 w-10 text-[9px] font-semibold uppercase tracking-[0.08em]"
            />
          );
        })}
      </TabList>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border)] px-3">
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
              {activeTab.label}
            </div>
            <div className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-disabled)]">
              {selectedClipId ? "Clip Selected" : "No Clip"}
            </div>
          </div>
        </div>
        <div
          role="tabpanel"
          id={`inspector-panel-${selectedTab}`}
          aria-labelledby={`inspector-tab-${selectedTab}`}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1 py-1"
        >
          {body}
        </div>
      </div>
    </aside>
  );
}

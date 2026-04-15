/**
 * InspectorPanel (Plan 02-12b).
 *
 * Tabbed side panel: Presets | Effects | Sound. Built with a thin
 * button-group + conditional render rather than a heavy Tabs primitive;
 * keyboard navigation works out of the box with native buttons + Tab.
 *
 * Plan 02-12a provides `selectedTab` + `setSelectedTab`; the render
 * switch below is a simple map.
 */

import { useMemo } from "react";

import { useEditorStore } from "../state/store";
import type { InspectorTab } from "../state/selection-slice";
import { EffectParams } from "./effect-params";
import { PresetPicker } from "./preset-picker";

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "presets", label: "Presets" },
  { id: "effects", label: "Effects" },
  { id: "sound", label: "Sound" },
];

export function InspectorPanel() {
  const selectedTab = useEditorStore((s) => s.selectedTab);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);
  const setSoundDrawerOpen = useEditorStore((s) => s.setSoundDrawerOpen);

  const body = useMemo(() => {
    switch (selectedTab) {
      case "presets":
        return <PresetPicker scope="project" />;
      case "effects":
        return <EffectParams />;
      case "sound":
        return (
          <div className="p-4 text-sm text-[var(--color-fg-muted)]">
            <p className="mb-3">
              Drag SFX or music clips onto the Sound track, or open the full
              sound library.
            </p>
            <button
              type="button"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-hi)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
              onClick={() => setSoundDrawerOpen(true)}
            >
              Open sound library
            </button>
          </div>
        );
    }
  }, [selectedTab, setSoundDrawerOpen]);

  return (
    <aside
      role="complementary"
      aria-label="Inspector"
      className="flex h-full w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]"
    >
      <div
        role="tablist"
        aria-label="Inspector sections"
        className="flex shrink-0 border-b border-[var(--color-border)]"
      >
        {TABS.map((t) => {
          const active = t.id === selectedTab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`inspector-panel-${t.id}`}
              id={`inspector-tab-${t.id}`}
              tabIndex={active ? 0 : -1}
              className={`flex-1 px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                active
                  ? "border-b-2 border-[var(--color-accent,#ff5b76)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              }`}
              onClick={() => setSelectedTab(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`inspector-panel-${selectedTab}`}
        aria-labelledby={`inspector-tab-${selectedTab}`}
        className="flex-1 overflow-auto"
      >
        {body}
      </div>
    </aside>
  );
}

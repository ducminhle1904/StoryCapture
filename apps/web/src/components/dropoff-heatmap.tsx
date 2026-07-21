"use client";

import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";

/**
 * Scene drop-off heatmap for analytics dashboard.
 * Horizontal bar chart showing per-scene viewer retention.
 * Color gradient: green (high retention) to red (high drop-off).
 * Bucketed per scene from DSL scene boundaries.
 */

interface SceneDropoff {
  sceneIndex: number;
  viewers: number;
  dropoff: number;
}

interface DropoffHeatmapProps {
  data: SceneDropoff[];
  /** Scene labels from DSL boundaries, indexed by sceneIndex */
  sceneLabels?: string[];
}

function retentionColor(ratio: number): string {
  // ratio: 0 = no viewers left (red), 1 = all viewers remain (green)
  if (ratio >= 0.8) return "bg-[var(--color-text-green)]";
  if (ratio >= 0.6) return "bg-[var(--color-text-teal)]";
  if (ratio >= 0.4) return "bg-[var(--color-text-yellow)]";
  if (ratio >= 0.2) return "bg-[var(--color-text-orange)]";
  return "bg-[var(--color-text-red)]";
}

export function DropoffHeatmap({ data, sceneLabels }: DropoffHeatmapProps) {
  if (data.length === 0) {
    return (
      <Card padding={6}>
        <EmptyState title="Scene Drop-off" description="No scene data yet." isCompact />
      </Card>
    );
  }

  const maxViewers = Math.max(...data.map((d) => d.viewers), 1);

  return (
    <Card padding={6}>
      <h3 className="mb-4 text-sm font-medium text-[var(--color-text-secondary)]">
        Scene Drop-off
      </h3>

      <div className="space-y-3">
        {data.map((scene) => {
          const widthPct = (scene.viewers / maxViewers) * 100;
          const retentionRatio = scene.viewers / maxViewers;
          const label = sceneLabels?.[scene.sceneIndex] ?? `Scene ${scene.sceneIndex + 1}`;

          return (
            <div key={scene.sceneIndex}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-[var(--color-text-primary)]">{label}</span>
                <span className="text-[var(--color-text-secondary)]">
                  {scene.viewers.toLocaleString()} viewers
                  {scene.dropoff > 0 && (
                    <span className="ml-1 text-[var(--color-error)]">(-{scene.dropoff})</span>
                  )}
                </span>
              </div>
              <div className="h-6 w-full rounded-[var(--radius-element)] bg-[var(--color-background-muted)]">
                <div
                  className={`h-full rounded ${retentionColor(retentionRatio)} transition-all`}
                  style={{ width: `${Math.max(widthPct, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
        <div className="flex items-center gap-1">
          <div className="h-2 w-2 rounded-full bg-[var(--color-text-green)]" />
          <span>High retention</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="h-2 w-2 rounded-full bg-[var(--color-text-red)]" />
          <span>High drop-off</span>
        </div>
      </div>
    </Card>
  );
}

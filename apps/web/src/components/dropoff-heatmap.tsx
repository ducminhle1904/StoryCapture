"use client";

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
  if (ratio >= 0.8) return "bg-emerald-500";
  if (ratio >= 0.6) return "bg-emerald-600";
  if (ratio >= 0.4) return "bg-yellow-500";
  if (ratio >= 0.2) return "bg-orange-500";
  return "bg-red-500";
}

export function DropoffHeatmap({ data, sceneLabels }: DropoffHeatmapProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="mb-4 text-sm font-medium text-zinc-400">Scene Drop-off</h3>
        <p className="text-sm text-zinc-500">No scene data yet.</p>
      </div>
    );
  }

  const maxViewers = Math.max(...data.map((d) => d.viewers), 1);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
      <h3 className="mb-4 text-sm font-medium text-zinc-400">Scene Drop-off</h3>

      <div className="space-y-3">
        {data.map((scene) => {
          const widthPct = (scene.viewers / maxViewers) * 100;
          const retentionRatio = scene.viewers / maxViewers;
          const label = sceneLabels?.[scene.sceneIndex] ?? `Scene ${scene.sceneIndex + 1}`;

          return (
            <div key={scene.sceneIndex}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-300">{label}</span>
                <span className="text-zinc-500">
                  {scene.viewers.toLocaleString()} viewers
                  {scene.dropoff > 0 && (
                    <span className="ml-1 text-red-400">(-{scene.dropoff})</span>
                  )}
                </span>
              </div>
              <div className="h-6 w-full rounded bg-zinc-800">
                <div
                  className={`h-full rounded ${retentionColor(retentionRatio)} transition-all`}
                  style={{ width: `${Math.max(widthPct, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
        <div className="flex items-center gap-1">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <span>High retention</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="h-2 w-2 rounded-full bg-red-500" />
          <span>High drop-off</span>
        </div>
      </div>
    </div>
  );
}

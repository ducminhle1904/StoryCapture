"use client";

import { useState } from "react";
import { DropoffHeatmap } from "./dropoff-heatmap";
import { GeoBreakdown } from "./geo-breakdown";

/**
 * Analytics dashboard for a video (Plan 04-08, D-06).
 * Shows: play count (total + unique), watch duration (avg + median),
 * scene drop-off heatmap, geographic breakdown.
 * Default time range: 30 days per D-06.
 */

interface DashboardData {
  totalPlays: number;
  uniquePlays: number;
  avgDurationSec: number;
  medianDurationSec: number;
  sceneDropoffs: Array<{
    sceneIndex: number;
    viewers: number;
    dropoff: number;
  }>;
  countryBreakdown: Array<{
    country: string;
    count: number;
  }>;
  periodDays: number;
}

interface AnalyticsDashboardProps {
  videoId: string;
  sceneLabels?: string[];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function StatCard({
  label,
  value,
  subtext,
}: {
  label: string;
  value: string;
  subtext?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-zinc-100">{value}</p>
      {subtext && (
        <p className="mt-1 text-xs text-zinc-500">{subtext}</p>
      )}
    </div>
  );
}

export function AnalyticsDashboard({
  videoId,
  sceneLabels,
}: AnalyticsDashboardProps) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch dashboard data via tRPC
  // Using useEffect + fetch instead of tRPC hooks to avoid needing provider at this level
  useState(() => {
    fetchDashboard(videoId, days).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  });

  const handleDaysChange = (newDays: number) => {
    setDays(newDays);
    setLoading(true);
    setError(null);
    fetchDashboard(videoId, newDays)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-800" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-zinc-800" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-300">
        Failed to load analytics: {error}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Time range selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-400">Time range:</span>
        {[7, 30].map((d) => (
          <button
            key={d}
            onClick={() => handleDaysChange(d)}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${
              days === d
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            Last {d} days
          </button>
        ))}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Total Plays"
          value={data.totalPlays.toLocaleString()}
        />
        <StatCard
          label="Unique Plays"
          value={data.uniquePlays.toLocaleString()}
        />
        <StatCard
          label="Avg Duration"
          value={formatDuration(data.avgDurationSec)}
        />
        <StatCard
          label="Median Duration"
          value={formatDuration(data.medianDurationSec)}
        />
      </div>

      {/* Drop-off heatmap */}
      <DropoffHeatmap data={data.sceneDropoffs} sceneLabels={sceneLabels} />

      {/* Geo breakdown */}
      <GeoBreakdown data={data.countryBreakdown} />
    </div>
  );
}

/**
 * Fetch analytics dashboard data.
 * Uses the Next.js tRPC API endpoint directly.
 */
async function fetchDashboard(
  videoId: string,
  days: number,
): Promise<DashboardData> {
  const params = new URLSearchParams();
  params.set(
    "input",
    JSON.stringify({ "0": { json: { videoId, days } } }),
  );

  const res = await fetch(
    `/api/trpc/analytics.dashboard?${params.toString()}`,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  const json = await res.json();
  // tRPC batched response format
  const result = Array.isArray(json) ? json[0] : json;
  return result?.result?.data?.json ?? result?.result?.data;
}

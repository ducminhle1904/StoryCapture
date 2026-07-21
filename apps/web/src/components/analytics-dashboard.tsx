"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useState } from "react";
import { DropoffHeatmap } from "./dropoff-heatmap";
import { GeoBreakdown } from "./geo-breakdown";

/**
 * Analytics dashboard for a video.
 * Shows: play count (total + unique), watch duration (avg + median),
 * scene drop-off heatmap, geographic breakdown. Default range: 30 days.
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

function StatCard({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
  return (
    <Card padding={4}>
      <p className="text-xs font-medium text-[var(--color-text-secondary)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-[var(--color-text-primary)]">{value}</p>
      {subtext && <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{subtext}</p>}
    </Card>
  );
}

export function AnalyticsDashboard({ videoId, sceneLabels }: AnalyticsDashboardProps) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch dashboard data via tRPC
  // Using useEffect + fetch instead of tRPC hooks to avoid needing provider at this level
  useState(() => {
    fetchDashboard(videoId, days)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
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
      <div className="flex justify-center py-12">
        <Spinner label="Loading analytics" />
      </div>
    );
  }

  if (error) {
    return <Banner status="error" title="Failed to load analytics" description={error} />;
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Time range selector */}
      <div className="flex items-center gap-2">
        <SegmentedControl
          label="Analytics time range"
          value={String(days)}
          onChange={(value) => handleDaysChange(Number(value))}
          size="sm"
        >
          <SegmentedControlItem value="7" label="Last 7 days" />
          <SegmentedControlItem value="30" label="Last 30 days" />
        </SegmentedControl>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total Plays" value={data.totalPlays.toLocaleString()} />
        <StatCard label="Unique Plays" value={data.uniquePlays.toLocaleString()} />
        <StatCard label="Avg Duration" value={formatDuration(data.avgDurationSec)} />
        <StatCard label="Median Duration" value={formatDuration(data.medianDurationSec)} />
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
async function fetchDashboard(videoId: string, days: number): Promise<DashboardData> {
  const params = new URLSearchParams();
  params.set("input", JSON.stringify({ "0": { json: { videoId, days } } }));

  const res = await fetch(`/api/trpc/analytics.dashboard?${params.toString()}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  const json = await res.json();
  // tRPC batched response format
  const result = Array.isArray(json) ? json[0] : json;
  return result?.result?.data?.json ?? result?.result?.data;
}

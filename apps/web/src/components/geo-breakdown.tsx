"use client";

/**
 * Geographic breakdown table for analytics dashboard.
 * Shows country-level view counts sorted by count descending.
 * Top 10 countries shown; rest grouped as "Other". No city-level data.
 */

/** ISO 3166-1 alpha-2 to flag emoji */
function countryFlag(code: string): string {
  if (code === "XX" || code.length !== 2) return "\u{1F310}"; // globe
  const codePoints = [...code.toUpperCase()].map(
    (c) => 0x1f1e6 - 65 + c.charCodeAt(0),
  );
  return String.fromCodePoint(...codePoints);
}

/** ISO 3166-1 alpha-2 to human-readable name (best-effort via Intl) */
function countryName(code: string): string {
  if (code === "XX") return "Unknown";
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

interface CountryData {
  country: string;
  count: number;
}

interface GeoBreakdownProps {
  data: CountryData[];
}

export function GeoBreakdown({ data }: GeoBreakdownProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="mb-4 text-sm font-medium text-zinc-400">
          Geographic Breakdown
        </h3>
        <p className="text-sm text-zinc-500">No geographic data yet.</p>
      </div>
    );
  }

  const total = data.reduce((sum, d) => sum + d.count, 0);

  // Top 10 + "Other"
  const top10 = data.slice(0, 10);
  const otherCount = data.slice(10).reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
      <h3 className="mb-4 text-sm font-medium text-zinc-400">
        Geographic Breakdown
      </h3>

      <div className="space-y-2">
        {top10.map((item) => {
          const pct = total > 0 ? ((item.count / total) * 100).toFixed(1) : "0";
          return (
            <div
              key={item.country}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="text-base">{countryFlag(item.country)}</span>
                <span className="text-zinc-200">
                  {countryName(item.country)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-zinc-400">{item.count.toLocaleString()}</span>
                <span className="w-12 text-right text-zinc-500">{pct}%</span>
              </div>
            </div>
          );
        })}

        {otherCount > 0 && (
          <div className="flex items-center justify-between border-t border-zinc-800 pt-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-base">{countryFlag("XX")}</span>
              <span className="text-zinc-400">Other</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-zinc-400">{otherCount.toLocaleString()}</span>
              <span className="w-12 text-right text-zinc-500">
                {total > 0 ? ((otherCount / total) * 100).toFixed(1) : "0"}%
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

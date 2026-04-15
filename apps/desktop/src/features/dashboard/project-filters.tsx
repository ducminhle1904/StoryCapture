import { Search, Clock, ArrowDownAZ } from "lucide-react";
import { useDashboardStore } from "@/state/projects";

export function ProjectFilters() {
  const { searchQuery, sortMode, setSearchQuery, setSortMode } =
    useDashboardStore();

  return (
    <div className="flex items-center gap-3">
      <label className="relative flex-1 max-w-md">
        <span className="sr-only">Search projects</span>
        <Search
          size={16}
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-fg-muted)]"
        />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search projects…"
          aria-label="Search projects by name"
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] text-[var(--color-fg-primary)] pl-9 pr-3 py-2 text-sm placeholder:text-[var(--color-fg-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        />
      </label>

      <div
        role="radiogroup"
        aria-label="Sort projects"
        className="inline-flex rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-1"
      >
        <button
          role="radio"
          aria-checked={sortMode === "recent"}
          onClick={() => setSortMode("recent")}
          aria-label="Sort by most recently opened"
          className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
            sortMode === "recent"
              ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg-primary)]"
              : "text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
          }`}
        >
          <Clock size={14} aria-hidden="true" />
          Recent
        </button>
        <button
          role="radio"
          aria-checked={sortMode === "name"}
          onClick={() => setSortMode("name")}
          aria-label="Sort by name"
          className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
            sortMode === "name"
              ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg-primary)]"
              : "text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
          }`}
        >
          <ArrowDownAZ size={14} aria-hidden="true" />
          Name
        </button>
      </div>
    </div>
  );
}

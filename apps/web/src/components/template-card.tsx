"use client";

import { formatWorkflowType } from "@/lib/workflows";

const CATEGORY_COLORS: Record<string, { badge: string; gradient: string }> = {
  SAAS_ONBOARDING: {
    badge: "bg-blue-500/20 text-blue-400",
    gradient: "from-blue-600/30 to-blue-900/30",
  },
  ECOMMERCE_CHECKOUT: {
    badge: "bg-green-500/20 text-green-400",
    gradient: "from-green-600/30 to-green-900/30",
  },
  API_WALKTHROUGH: {
    badge: "bg-purple-500/20 text-purple-400",
    gradient: "from-purple-600/30 to-purple-900/30",
  },
  MOBILE_DEMO: {
    badge: "bg-pink-500/20 text-pink-400",
    gradient: "from-pink-600/30 to-pink-900/30",
  },
  CLI_TOOL: {
    badge: "bg-zinc-500/20 text-zinc-400",
    gradient: "from-zinc-600/30 to-zinc-800/30",
  },
  LANDING_PAGE: {
    badge: "bg-orange-500/20 text-orange-400",
    gradient: "from-orange-600/30 to-orange-900/30",
  },
  FEATURE_ANNOUNCEMENT: {
    badge: "bg-yellow-500/20 text-yellow-400",
    gradient: "from-yellow-600/30 to-yellow-900/30",
  },
  BUG_REPRODUCTION: {
    badge: "bg-red-500/20 text-red-400",
    gradient: "from-red-600/30 to-red-900/30",
  },
  INTERNAL_TRAINING: {
    badge: "bg-teal-500/20 text-teal-400",
    gradient: "from-teal-600/30 to-teal-900/30",
  },
};

const DEFAULT_CATEGORY_COLORS = {
  badge: "bg-zinc-500/20 text-zinc-400",
  gradient: "from-zinc-600/30 to-zinc-800/30",
};

function formatCategoryLabel(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

interface TemplateCardProps {
  id: string;
  name: string;
  description: string | null;
  category: string;
  workflowType?: string | null;
  bestFor?: string | null;
  durationTarget?: string | null;
  polishPreset?: string | null;
  forkCount: number;
  thumbnailUrl: string | null;
  onUseTemplate: (id: string) => void;
}

export function TemplateCard({
  id,
  name,
  description,
  category,
  workflowType,
  bestFor,
  durationTarget,
  polishPreset,
  forkCount,
  onUseTemplate,
}: TemplateCardProps) {
  const colors = CATEGORY_COLORS[category] ?? DEFAULT_CATEGORY_COLORS;
  const badgeLabel = formatWorkflowType(workflowType) ?? formatCategoryLabel(category);

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 transition-all duration-200 hover:scale-[1.02] hover:border-zinc-700 hover:shadow-lg hover:shadow-zinc-950/50">
      <div className={`flex h-32 items-center justify-center bg-gradient-to-br ${colors.gradient}`}>
        <span className="text-3xl font-bold text-white/20">{name.charAt(0)}</span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <span
          className={`mb-2 inline-flex w-fit rounded-full px-2.5 py-0.5 text-xs font-medium ${colors.badge}`}
        >
          {badgeLabel}
        </span>

        <h3 className="text-sm font-semibold text-zinc-100">{name}</h3>

        {description && <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{description}</p>}

        {(bestFor || durationTarget || polishPreset) && (
          <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
            {bestFor && <p className="line-clamp-1">Best for: {bestFor}</p>}
            <div className="flex flex-wrap gap-1.5">
              {durationTarget && (
                <span className="rounded-full bg-zinc-800 px-2 py-0.5">{durationTarget}</span>
              )}
              {polishPreset && (
                <span className="rounded-full bg-zinc-800 px-2 py-0.5">{polishPreset}</span>
              )}
            </div>
          </div>
        )}

        <div className="mt-auto flex items-center justify-between pt-4">
          <span className="flex items-center gap-1 text-xs text-zinc-500">
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-label="Fork count"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
              />
            </svg>
            {forkCount} {forkCount === 1 ? "fork" : "forks"}
          </span>

          <button
            type="button"
            onClick={() => onUseTemplate(id)}
            className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            Use Template
          </button>
        </div>
      </div>
    </div>
  );
}

export { CATEGORY_COLORS, formatCategoryLabel };

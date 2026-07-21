"use client";

import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { formatWorkflowType } from "@/lib/workflows";

const CATEGORY_COLORS: Record<string, { badge: BadgeVariant; surface: string }> = {
  SAAS_ONBOARDING: {
    badge: "blue",
    surface: "bg-[var(--color-background-blue)]",
  },
  ECOMMERCE_CHECKOUT: {
    badge: "green",
    surface: "bg-[var(--color-background-green)]",
  },
  API_WALKTHROUGH: {
    badge: "purple",
    surface: "bg-[var(--color-background-purple)]",
  },
  MOBILE_DEMO: {
    badge: "pink",
    surface: "bg-[var(--color-background-pink)]",
  },
  CLI_TOOL: {
    badge: "neutral",
    surface: "bg-[var(--color-background-muted)]",
  },
  LANDING_PAGE: {
    badge: "orange",
    surface: "bg-[var(--color-background-orange)]",
  },
  FEATURE_ANNOUNCEMENT: {
    badge: "yellow",
    surface: "bg-[var(--color-background-yellow)]",
  },
  BUG_REPRODUCTION: {
    badge: "red",
    surface: "bg-[var(--color-background-red)]",
  },
  INTERNAL_TRAINING: {
    badge: "teal",
    surface: "bg-[var(--color-background-teal)]",
  },
};

const DEFAULT_CATEGORY_COLORS = {
  badge: "neutral" as const,
  surface: "bg-[var(--color-background-muted)]",
} satisfies { badge: BadgeVariant; surface: string };

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
    <Card
      padding={0}
      className="group flex flex-col overflow-hidden transition-transform duration-200 hover:scale-[1.02]"
    >
      <div className={`flex h-32 items-center justify-center ${colors.surface}`}>
        <span className="text-3xl font-bold text-[var(--color-text-secondary)]">
          {name.charAt(0)}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="mb-2">
          <Badge variant={colors.badge} label={badgeLabel} />
        </div>

        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{name}</h3>

        {description && (
          <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-secondary)]">
            {description}
          </p>
        )}

        {(bestFor || durationTarget || polishPreset) && (
          <div className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-secondary)]">
            {bestFor && <p className="line-clamp-1">Best for: {bestFor}</p>}
            <div className="flex flex-wrap gap-1.5">
              {durationTarget && <Badge label={durationTarget} />}
              {polishPreset && <Badge label={polishPreset} />}
            </div>
          </div>
        )}

        <div className="mt-auto flex items-center justify-between pt-4">
          <span className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
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

          <Button
            label="Use template"
            variant="primary"
            size="sm"
            onClick={() => onUseTemplate(id)}
          />
        </div>
      </div>
    </Card>
  );
}

export { CATEGORY_COLORS, formatCategoryLabel };

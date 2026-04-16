"use client";

import { useState } from "react";
import { useTRPC } from "@/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { TemplateCard, formatCategoryLabel } from "./template-card";

const ALL_CATEGORIES = [
  "SAAS_ONBOARDING",
  "ECOMMERCE_CHECKOUT",
  "API_WALKTHROUGH",
  "MOBILE_DEMO",
  "CLI_TOOL",
  "LANDING_PAGE",
  "FEATURE_ANNOUNCEMENT",
  "BUG_REPRODUCTION",
  "INTERNAL_TRAINING",
] as const;

interface TemplateGridProps {
  onUseTemplate: (templateId: string) => void;
}

export function TemplateGrid({ onUseTemplate }: TemplateGridProps) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const trpc = useTRPC();

  const { data, isLoading } = useQuery(
    trpc.template.listByCategory.queryOptions(
      activeCategory ? { category: activeCategory as (typeof ALL_CATEGORIES)[number] } : undefined,
    ),
  );

  return (
    <div className="space-y-6">
      {/* Category filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        <button
          onClick={() => setActiveCategory(null)}
          className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            activeCategory === null
              ? "bg-zinc-100 text-zinc-900"
              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
          }`}
        >
          All
        </button>
        {ALL_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              activeCategory === cat
                ? "bg-zinc-100 text-zinc-900"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
            }`}
          >
            {formatCategoryLabel(cat)}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
        </div>
      )}

      {/* Template grid grouped by category */}
      {data && !isLoading && (
        <div className="space-y-10">
          {Object.entries(data.grouped).map(([category, templates]) => (
            <section key={category}>
              <h3 className="mb-4 text-lg font-semibold text-zinc-200">
                {formatCategoryLabel(category)}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    id={template.id}
                    name={template.name}
                    description={template.description}
                    category={template.category}
                    forkCount={template.forkCount}
                    thumbnailUrl={template.thumbnailUrl}
                    onUseTemplate={onUseTemplate}
                  />
                ))}
              </div>
            </section>
          ))}

          {Object.keys(data.grouped).length === 0 && (
            <p className="py-12 text-center text-sm text-zinc-500">
              No templates found.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

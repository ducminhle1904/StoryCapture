"use client";

import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";
import { formatCategoryLabel, TemplateCard } from "./template-card";

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
      <Selector
        label="Template category"
        value={activeCategory ?? "ALL"}
        onChange={(value) => setActiveCategory(value === "ALL" ? null : value)}
        options={[
          { value: "ALL", label: "All categories" },
          ...ALL_CATEGORIES.map((category) => ({
            value: category,
            label: formatCategoryLabel(category),
          })),
        ]}
        width={260}
      />

      {/* Loading state */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <Spinner label="Loading templates" />
        </div>
      )}

      {/* Template grid grouped by category */}
      {data && !isLoading && (
        <div className="space-y-10">
          {Object.entries(data.grouped).map(([category, templates]) => (
            <section key={category}>
              <h3 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
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
                    workflowType={template.workflowType}
                    bestFor={template.bestFor}
                    durationTarget={template.durationTarget}
                    polishPreset={template.polishPreset}
                    forkCount={template.forkCount}
                    thumbnailUrl={template.thumbnailUrl}
                    onUseTemplate={onUseTemplate}
                  />
                ))}
              </div>
            </section>
          ))}

          {Object.keys(data.grouped).length === 0 && (
            <p className="py-12 text-center text-sm text-[var(--color-text-secondary)]">
              No templates found.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

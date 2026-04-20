/**
 * ToggleGroup primitive — shadcn-style chrome on top of Base UI's ToggleGroup (D-32).
 *
 * Phase 13 first use: FitMode selector (letterbox / crop / stretch).
 * Single-select via `toggleMultiple={false}`; items use Base UI Toggle.
 */

import { Toggle as BaseToggle } from "@base-ui-components/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui-components/react/toggle-group";
import * as React from "react";

import { cn } from "@/lib/utils";

export const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof BaseToggleGroup>,
  React.ComponentPropsWithoutRef<typeof BaseToggleGroup>
>(({ className, ...props }, ref) => (
  <BaseToggleGroup
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] p-1",
      className,
    )}
    {...props}
  />
));
ToggleGroup.displayName = "ToggleGroup";

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof BaseToggle>,
  React.ComponentPropsWithoutRef<typeof BaseToggle>
>(({ className, children, ...props }, ref) => (
  <BaseToggle
    ref={ref}
    className={cn(
      "inline-flex h-7 items-center justify-center gap-1 rounded-[var(--radius-sm)] px-2.5 text-xs font-medium text-[var(--color-fg-secondary)] outline-none transition-colors",
      "hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]",
      "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
      "data-[pressed]:bg-[var(--color-surface-400)] data-[pressed]:text-[var(--color-fg-primary)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    {children}
  </BaseToggle>
));
ToggleGroupItem.displayName = "ToggleGroupItem";

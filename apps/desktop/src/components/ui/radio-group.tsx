/**
 * RadioGroup primitive — shadcn-style chrome on top of Base UI's RadioGroup.
 *
 * Each item is a Base UI Radio.Root with an Indicator dot.
 */

import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import * as React from "react";

import { cn } from "@/lib/utils";

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof BaseRadioGroup>,
  React.ComponentPropsWithoutRef<typeof BaseRadioGroup>
>(({ className, ...props }, ref) => (
  <BaseRadioGroup ref={ref} className={cn("grid gap-2", className)} {...props} />
));
RadioGroup.displayName = "RadioGroup";

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof BaseRadio.Root>,
  React.ComponentPropsWithoutRef<typeof BaseRadio.Root>
>(({ className, ...props }, ref) => (
  <BaseRadio.Root
    ref={ref}
    className={cn(
      "relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-border-default)] bg-[var(--color-surface-100)] outline-none transition-colors",
      "hover:border-[var(--color-border-strong)]",
      "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
      "data-[checked]:border-[var(--color-accent-primary)] data-[checked]:bg-[var(--color-accent-primary)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <BaseRadio.Indicator className="flex h-1.5 w-1.5 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-surface-100)] data-[unchecked]:hidden" />
  </BaseRadio.Root>
));
RadioGroupItem.displayName = "RadioGroupItem";

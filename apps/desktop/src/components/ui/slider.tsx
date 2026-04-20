/**
 * Slider primitive — shadcn-style chrome on top of Base UI's Slider (D-32).
 *
 * Phase 13 first use: bitrate / keyframe-interval tuning with numeric readout.
 * Supports single-thumb value; multi-thumb can be extended from Base UI parts.
 */

import { Slider as BaseSlider } from "@base-ui-components/react/slider";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Slider = React.forwardRef<
  React.ElementRef<typeof BaseSlider.Root>,
  React.ComponentPropsWithoutRef<typeof BaseSlider.Root>
>(({ className, min = 0, max = 100, ...props }, ref) => (
  <BaseSlider.Root
    ref={ref}
    min={min}
    max={max}
    className={cn("relative flex w-full items-center select-none", className)}
    {...props}
  >
    <BaseSlider.Control className="relative flex h-5 w-full items-center">
      <BaseSlider.Track className="relative h-1 w-full grow overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-surface-400)]">
        <BaseSlider.Indicator className="absolute h-full rounded-[var(--radius-pill)] bg-[var(--color-accent-primary)]" />
      </BaseSlider.Track>
      <BaseSlider.Thumb
        className={cn(
          "block h-4 w-4 rounded-[var(--radius-pill)] border border-[var(--color-border-strong)] bg-[var(--color-surface-100)] shadow-[var(--shadow-focus)] outline-none transition-colors",
          "hover:bg-[var(--color-surface-300)]",
          "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        )}
      />
    </BaseSlider.Control>
  </BaseSlider.Root>
));
Slider.displayName = "Slider";

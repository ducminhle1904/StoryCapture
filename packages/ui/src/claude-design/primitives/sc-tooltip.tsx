"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScTooltipProvider = Tooltip.Provider;
export const ScTooltip = Tooltip.Root;
export const ScTooltipTrigger = Tooltip.Trigger;

export const ScTooltipContent = forwardRef<
  ElementRef<typeof Tooltip.Popup>,
  ComponentPropsWithoutRef<typeof Tooltip.Popup>
>(({ className, ...props }, ref) => (
  <Tooltip.Portal>
    <Tooltip.Positioner sideOffset={6} className="sc-tooltip-positioner">
      <Tooltip.Popup ref={ref} className={cn("sc-tooltip-popup", className)} {...props} />
    </Tooltip.Positioner>
  </Tooltip.Portal>
));
ScTooltipContent.displayName = "ScTooltipContent";

"use client";

import { Popover } from "@base-ui/react/popover";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScPopover = Popover.Root;
export const ScPopoverTrigger = Popover.Trigger;
export const ScPopoverClose = Popover.Close;
export const ScPopoverTitle = Popover.Title;
export const ScPopoverDescription = Popover.Description;

export const ScPopoverContent = forwardRef<
  ElementRef<typeof Popover.Popup>,
  ComponentPropsWithoutRef<typeof Popover.Popup>
>(({ className, ...props }, ref) => (
  <Popover.Portal>
    <Popover.Positioner sideOffset={8} className="sc-popover-positioner">
      <Popover.Popup ref={ref} className={cn("sc-popover-popup", className)} {...props} />
    </Popover.Positioner>
  </Popover.Portal>
));
ScPopoverContent.displayName = "ScPopoverContent";

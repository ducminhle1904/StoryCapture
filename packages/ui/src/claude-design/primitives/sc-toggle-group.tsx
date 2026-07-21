"use client";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScToggleGroup = forwardRef<
  ElementRef<typeof ToggleGroup>,
  ComponentPropsWithoutRef<typeof ToggleGroup>
>(({ className, ...props }, ref) => (
  <ToggleGroup ref={ref} className={cn("sc-toggle-group", className)} {...props} />
));
ScToggleGroup.displayName = "ScToggleGroup";

export const ScToggleGroupItem = forwardRef<
  ElementRef<typeof Toggle>,
  ComponentPropsWithoutRef<typeof Toggle>
>(({ className, ...props }, ref) => (
  <Toggle ref={ref} className={cn("sc-toggle-group-item", className)} {...props} />
));
ScToggleGroupItem.displayName = "ScToggleGroupItem";

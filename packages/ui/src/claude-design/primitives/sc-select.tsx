import { Select } from "@base-ui-components/react/select";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScSelect = Select.Root;
export const ScSelectValue = Select.Value;

export const ScSelectTrigger = forwardRef<
  ElementRef<typeof Select.Trigger>,
  ComponentPropsWithoutRef<typeof Select.Trigger>
>(({ className, children, ...props }, ref) => (
  <Select.Trigger ref={ref} className={cn("sc-select", className)} {...props}>
    {children}
    <Select.Icon />
  </Select.Trigger>
));
ScSelectTrigger.displayName = "ScSelectTrigger";

export const ScSelectContent = forwardRef<
  ElementRef<typeof Select.Popup>,
  ComponentPropsWithoutRef<typeof Select.Popup>
>(({ className, children, ...props }, ref) => (
  <Select.Portal>
    <Select.Positioner sideOffset={4}>
      <Select.Popup ref={ref} className={cn("sc-select-popup sc-card", className)} {...props}>
        {children}
      </Select.Popup>
    </Select.Positioner>
  </Select.Portal>
));
ScSelectContent.displayName = "ScSelectContent";

export const ScSelectItem = forwardRef<
  ElementRef<typeof Select.Item>,
  ComponentPropsWithoutRef<typeof Select.Item>
>(({ className, children, ...props }, ref) => (
  <Select.Item ref={ref} className={cn("sc-select-item", className)} {...props}>
    <Select.ItemText>{children}</Select.ItemText>
  </Select.Item>
));
ScSelectItem.displayName = "ScSelectItem";

import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScSelect = Select.Root;
export const ScSelectValue = Select.Value;
export const ScSelectGroup = Select.Group;

export const ScSelectTrigger = forwardRef<
  ElementRef<typeof Select.Trigger>,
  ComponentPropsWithoutRef<typeof Select.Trigger>
>(({ className, children, ...props }, ref) => (
  <Select.Trigger ref={ref} className={cn("sc-select", className)} {...props}>
    {children}
    <Select.Icon className="sc-select-icon">
      <ChevronDown aria-hidden="true" size={14} />
    </Select.Icon>
  </Select.Trigger>
));
ScSelectTrigger.displayName = "ScSelectTrigger";

export const ScSelectContent = forwardRef<
  ElementRef<typeof Select.Popup>,
  ComponentPropsWithoutRef<typeof Select.Popup>
>(({ className, children, ...props }, ref) => (
  <Select.Portal>
    <Select.Positioner sideOffset={6} className="sc-select-positioner">
      <Select.Popup ref={ref} className={cn("sc-select-popup", className)} {...props}>
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
    <span className="sc-select-check" aria-hidden="true">
      <Select.ItemIndicator className="sc-select-indicator">
        <Check aria-hidden="true" size={12} />
      </Select.ItemIndicator>
    </span>
    <Select.ItemText>{children}</Select.ItemText>
  </Select.Item>
));
ScSelectItem.displayName = "ScSelectItem";

export const ScSelectGroupLabel = forwardRef<
  ElementRef<typeof Select.GroupLabel>,
  ComponentPropsWithoutRef<typeof Select.GroupLabel>
>(({ className, ...props }, ref) => (
  <Select.GroupLabel ref={ref} className={cn("sc-select-group-label", className)} {...props} />
));
ScSelectGroupLabel.displayName = "ScSelectGroupLabel";

export const ScSelectSeparator = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  ({ className, ...props }, ref) => (
    <div ref={ref} role="separator" className={cn("sc-select-separator", className)} {...props} />
  ),
);
ScSelectSeparator.displayName = "ScSelectSeparator";

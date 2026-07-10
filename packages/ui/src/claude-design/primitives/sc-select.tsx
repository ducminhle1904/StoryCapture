import { Select } from "@base-ui/react/select";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from "react";

import { cn } from "../../lib/cn";

function SelectChevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.25 6.25 8 10l3.75-3.75" />
    </svg>
  );
}

export const ScSelect = Select.Root;
export const ScSelectValue = Select.Value;

export const ScSelectTrigger = forwardRef<
  ElementRef<typeof Select.Trigger>,
  ComponentPropsWithoutRef<typeof Select.Trigger>
>(({ className, children, ...props }, ref) => (
  <Select.Trigger ref={ref} className={cn("sc-select", className)} {...props}>
    {children}
    <Select.Icon className="sc-select-icon">
      <SelectChevron />
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
        <span className="sc-select-indicator-mark" />
      </Select.ItemIndicator>
    </span>
    <Select.ItemText>{children}</Select.ItemText>
  </Select.Item>
));
ScSelectItem.displayName = "ScSelectItem";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export interface ScSegmentedOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface ScSegmentedProps
  extends Omit<
    ComponentPropsWithoutRef<typeof ToggleGroup>,
    "value" | "defaultValue" | "onValueChange"
  > {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: ScSegmentedOption[];
  size?: "sm" | "md";
}

export const ScSegmented = forwardRef<ElementRef<typeof ToggleGroup>, ScSegmentedProps>(
  ({ value, defaultValue, onValueChange, options, size = "md", className, ...rest }, ref) => (
    <ToggleGroup
      ref={ref}
      value={value === undefined ? undefined : [value]}
      defaultValue={defaultValue === undefined ? undefined : [defaultValue]}
      onValueChange={(next) => {
        const [first] = next;
        if (first !== undefined) onValueChange?.(first as string);
      }}
      className={cn("sc-segmented", size === "sm" && "sm", className)}
      {...rest}
    >
      {options.map((opt) => (
        <Toggle
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          title={opt.title}
          className="sc-segmented-item"
        >
          {opt.label}
        </Toggle>
      ))}
    </ToggleGroup>
  ),
);
ScSegmented.displayName = "ScSegmented";

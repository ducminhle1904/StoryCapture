import { Toggle } from "@base-ui-components/react/toggle";
import { ToggleGroup } from "@base-ui-components/react/toggle-group";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export interface ScSegmentedOption {
  value: string;
  label: ReactNode;
}

export interface ScSegmentedProps
  extends Omit<ComponentPropsWithoutRef<typeof ToggleGroup>, "value" | "defaultValue" | "onValueChange"> {
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
      toggleMultiple={false}
      value={value === undefined ? undefined : [value]}
      defaultValue={defaultValue === undefined ? undefined : [defaultValue]}
      onValueChange={(next) => {
        const [first] = next;
        if (first !== undefined) onValueChange?.(first);
      }}
      className={cn("sc-segmented", size === "sm" && "sm", className)}
      {...rest}
    >
      {options.map((opt) => (
        <Toggle key={opt.value} value={opt.value} className="sc-segmented-item">
          {opt.label}
        </Toggle>
      ))}
    </ToggleGroup>
  ),
);
ScSegmented.displayName = "ScSegmented";

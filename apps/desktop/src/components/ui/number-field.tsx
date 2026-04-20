/**
 * NumberField — Input wrapper with numeric parsing + min/max/step + aria-invalid wiring.
 *
 * Phase 13 D-13-08: Custom W/H inputs and keyframe interval.
 */

import * as React from "react";
import { Input } from "./input";

export interface NumberFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  value: number | "";
  onChange: (n: number | "") => void;
  min?: number;
  max?: number;
  step?: number;
  invalid?: boolean;
  errorId?: string;
}

export const NumberField = React.forwardRef<HTMLInputElement, NumberFieldProps>(
  ({ value, onChange, min, max, step = 1, invalid, errorId, ...rest }, ref) => (
    <Input
      ref={ref}
      type="number"
      value={value === "" ? "" : String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange("");
        const n = Number(raw);
        if (!Number.isNaN(n)) onChange(n);
      }}
      min={min}
      max={max}
      step={step}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? errorId : undefined}
      {...rest}
    />
  ),
);
NumberField.displayName = "NumberField";

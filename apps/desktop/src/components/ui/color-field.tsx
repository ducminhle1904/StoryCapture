/**
 * ColorField — native <input type="color"> + synced lowercase hex text input.
 *
 * Phase 13 D-13-09: pad-color picker. Two-way sync via shared onChange.
 * Hex must match /^#[0-9a-f]{6}$/ — invalid hex sets aria-invalid on the text input.
 */

import { cn } from "@/lib/utils";
import * as React from "react";

export interface ColorFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: string;
  onChange: (hex: string) => void;
}

const HEX_RE = /^#[0-9a-f]{6}$/;

export const ColorField = React.forwardRef<HTMLInputElement, ColorFieldProps>(
  ({ value, onChange, id, className, disabled, ...rest }, ref) => {
    const [text, setText] = React.useState(value);
    React.useEffect(() => setText(value), [value]);
    const invalid = !HEX_RE.test(text);
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <input
          type="color"
          value={value}
          onChange={(e) => {
            const v = e.target.value.toLowerCase();
            onChange(v);
            setText(v);
          }}
          disabled={disabled}
          aria-label="Pad color picker"
          className="h-9 w-12 cursor-pointer rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-transparent p-0"
        />
        <input
          ref={ref}
          id={id}
          type="text"
          value={text}
          onChange={(e) => {
            const v = e.target.value.toLowerCase();
            setText(v);
            if (HEX_RE.test(v)) onChange(v);
          }}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          {...rest}
          className="h-9 w-28 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2 font-mono text-xs text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] aria-[invalid=true]:border-[var(--color-danger)]"
        />
      </div>
    );
  },
);
ColorField.displayName = "ColorField";

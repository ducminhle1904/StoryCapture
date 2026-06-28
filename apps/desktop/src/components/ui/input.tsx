/**
 * Input primitive — shadcn-style chrome on top of Base UI's Input.
 *
 * aria-invalid styling is wired through tokens.
 */

import { Input as BaseInput } from "@base-ui/react/input";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  React.ElementRef<typeof BaseInput>,
  React.ComponentPropsWithoutRef<typeof BaseInput>
>(({ className, type, ...props }, ref) => (
  <BaseInput
    ref={ref}
    type={type}
    className={cn(
      "h-9 w-full min-w-0 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2.5 py-1 text-xs text-[var(--color-fg-primary)] outline-none transition-colors",
      "placeholder:text-[var(--color-fg-muted)]",
      "hover:bg-[var(--color-surface-300)]",
      "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "aria-[invalid=true]:border-[var(--color-danger)]",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

/**
 * Label primitive — shadcn-style chrome atop a native <label>.
 *
 * Token-only styling; inherits disabled styling from peer/group data attributes.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  htmlFor: string;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, htmlFor, children, ...props }, ref) => (
    <label
      ref={ref}
      htmlFor={htmlFor}
      className={cn(
        "flex items-center gap-2 text-xs font-medium leading-none text-[var(--color-fg-primary)] select-none",
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </label>
  ),
);
Label.displayName = "Label";

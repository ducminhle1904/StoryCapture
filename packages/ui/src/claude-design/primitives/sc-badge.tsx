import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ScBadgeTone = "neutral" | "accent" | "record" | "success" | "muted" | "info" | "warn";

export interface ScBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ScBadgeTone;
  /** @deprecated alias for `tone`, for parity with the design bundle's `variant` prop */
  variant?: ScBadgeTone;
  dot?: boolean;
  icon?: ReactNode;
}

export const ScBadge = forwardRef<HTMLSpanElement, ScBadgeProps>(
  ({ tone, variant, dot, icon, className, children, ...rest }, ref) => {
    const resolved = tone ?? variant ?? "neutral";
    return (
      <span
        ref={ref}
        className={cn("sc-badge", resolved !== "neutral" && resolved, className)}
        {...rest}
      >
        {dot && <span className="dot" />}
        {icon}
        {children}
      </span>
    );
  },
);
ScBadge.displayName = "ScBadge";
